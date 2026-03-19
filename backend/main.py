import json
import logging
import os
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from database import SessionLocal, engine
from llm import generate_response, generate_response_stream
from models import Base, Conversation, Message, Document, DocumentChunk
from rag import cosine_sim, embed_text, mmr_select

app = FastAPI()

logging.basicConfig(level=logging.INFO)
rag_logger = logging.getLogger("rag")
rag_logger.setLevel(logging.INFO)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    message: str
    conversation_id: UUID | None = None

class RagSource(BaseModel):
    chunk_id: UUID
    document_id: UUID
    title: str | None = None
    source: str | None = None
    score: float | None = None
    mmr_score: float | None = None
    content: str | None = None



class ChatResponse(BaseModel):
    conversation_id: UUID
    response: str
    sources: list[RagSource] | None = None


class ConversationSummary(BaseModel):
    id: UUID
    title: str | None = None
    message_count: int


class ConversationMessage(BaseModel):
    id: UUID
    role: str | None = None
    content: str
    status: str | None = None
    sequence_number: int


class RagSearchRequest(BaseModel):
    query: str
    top_k: int = 5
    candidate_k: int = 20
    min_score: float | None = None
    mmr_lambda: float = 0.5


class RagSearchResult(BaseModel):
    chunk_id: UUID
    document_id: UUID
    content: str
    score: float
    mmr_score: float | None = None
    title: str | None = None
    source: str | None = None


class RagSearchResponse(BaseModel):
    query: str
    top_k: int
    candidate_k: int
    min_score: float | None
    mmr_lambda: float
    results: list[RagSearchResult]


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


RAG_ENABLED = os.getenv("RAG_ENABLED", "true").lower() in {"1", "true", "yes"}
RAG_TOP_K = int(os.getenv("RAG_TOP_K", "5"))
RAG_CANDIDATE_K = int(os.getenv("RAG_CANDIDATE_K", "20"))
RAG_MIN_SCORE_RAW = os.getenv("RAG_MIN_SCORE")
if RAG_MIN_SCORE_RAW is None:
    RAG_MIN_SCORE_RAW = "0.5"
RAG_MIN_SCORE = None if RAG_MIN_SCORE_RAW == "" else float(RAG_MIN_SCORE_RAW)
RAG_MMR_LAMBDA = float(os.getenv("RAG_MMR_LAMBDA", "0.5"))


def _retrieve_rag_candidates(
    db: Session,
    query: str,
    top_k: int,
    candidate_k: int,
    min_score: float | None,
    mmr_lambda: float,
) -> list[dict]:
    query = query.strip()
    if not query:
        return []

    rag_logger.info(
        "rag_retrieve query=%r top_k=%s candidate_k=%s min_score=%s mmr_lambda=%s",
        query,
        top_k,
        candidate_k,
        min_score,
        mmr_lambda,
    )

    top_k = max(1, min(top_k, 50))
    candidate_k = max(top_k, min(candidate_k, 200))
    mmr_lambda = max(0.0, min(1.0, mmr_lambda))

    query_vec = embed_text(query)
    distance_expr = DocumentChunk.embedding.cosine_distance(query_vec)

    base_query = (
        db.query(DocumentChunk, Document)
        .join(Document, Document.id == DocumentChunk.document_id)
    )

    if min_score is not None:
        distance_threshold = 1 - min_score
        base_query = base_query.filter(distance_expr <= distance_threshold)

    rows = (
        base_query
        .order_by(distance_expr.asc())
        .limit(candidate_k)
        .all()
    )

    rag_logger.info("rag_retrieve db_rows=%s", len(rows))

    candidates: list[dict] = []
    for chunk, document in rows:
        if chunk.embedding is None:
            continue
        score = cosine_sim(query_vec, chunk.embedding)
        if min_score is not None and score < min_score:
            continue
        candidates.append(
            {
                "chunk_id": chunk.id,
                "document_id": chunk.document_id,
                "content": chunk.content,
                "title": document.title,
                "source": document.source,
                "score": score,
                "embedding": chunk.embedding,
            }
        )

    rag_logger.info("rag_retrieve candidates=%s", len(candidates))
    if not candidates:
        return []

    if mmr_lambda >= 1 or candidate_k <= top_k:
        selected = sorted(candidates, key=lambda item: item["score"], reverse=True)[:top_k]
    else:
        selected = mmr_select(query_vec, candidates, top_k, mmr_lambda)

    rag_logger.info("rag_retrieve selected=%s scores=%s", len(selected), [round(item["score"], 4) for item in selected[:3]])
    return selected


def _build_rag_prompt(question: str, results: list[dict]) -> str:
    if not results:
        return question

    context_blocks: list[str] = []
    for idx, item in enumerate(results, start=1):
        title = item.get("title") or "Untitled"
        source = item.get("source") or "unknown"
        content = item.get("content") or ""
        context_blocks.append(
            f"[{idx}] Title: {title}\nSource: {source}\nContent: {content}"
        )

    context_text = "\n\n".join(context_blocks)
    return (
        "Task: Decide if the reference is relevant to the user's question. "
        "If it is not directly relevant, ignore it completely and do not mention it. "
        "Always answer the user's question first and keep the topic aligned with the question.\n\n"
        f"User Question:\n{question}\n\n"
        f"Reference (may be irrelevant):\n{context_text}"
    )


def _format_rag_sources(results: list[dict]) -> list[dict]:
    sources: list[dict] = []
    for item in results:
        chunk_id = item.get("chunk_id")
        document_id = item.get("document_id")
        sources.append(
            {
                "chunk_id": str(chunk_id) if chunk_id is not None else None,
                "document_id": str(document_id) if document_id is not None else None,
                "title": item.get("title"),
                "source": item.get("source"),
                "score": item.get("score"),
                "content": item.get("content"),
                "mmr_score": item.get("mmr_score"),
            }
        )
    return sources


def _sanitize_rich_response(raw_response: str) -> str:
    try:
        data = json.loads(raw_response)
    except Exception:
        return raw_response

    if not isinstance(data, dict):
        return raw_response

    blocks = data.get("blocks")
    if not isinstance(blocks, list):
        return raw_response

    sanitized = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        if block.get("type") != "table":
            sanitized.append(block)
            continue

        headers = block.get("headers")
        rows = block.get("rows")
        if not isinstance(headers, list) or not isinstance(rows, list):
            continue

        header_len = len(headers)
        if header_len == 0:
            continue

        valid_rows = []
        malformed = False
        for row in rows:
            if not isinstance(row, list) or len(row) != header_len:
                malformed = True
                break
            clean_row = []
            for cell in row:
                if not isinstance(cell, str):
                    malformed = True
                    break
                if any(ch in cell for ch in "[]{}\""):
                    malformed = True
                    break
                clean_row.append(cell)
            if malformed:
                break
            valid_rows.append(clean_row)

        if malformed:
            # fallback: convert table into a list of "Header: value" lines if possible
            list_items = []
            for row in rows if isinstance(rows, list) else []:
                if not isinstance(row, list):
                    continue
                pairs = []
                for h, v in zip(headers, row):
                    if isinstance(h, str) and isinstance(v, str):
                        pairs.append(f"{h}: {v}")
                if pairs:
                    list_items.append("; ".join(pairs))
            if list_items:
                sanitized.append({"type": "list", "ordered": False, "items": list_items})
            # else drop the malformed table
            continue

        sanitized.append({"type": "table", "headers": headers, "rows": valid_rows})

    data["blocks"] = sanitized
    try:
        return json.dumps(data, ensure_ascii=False)
    except Exception:
        return raw_response


def _sse_event(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


class JsonCompletionDetector:
    def __init__(self) -> None:
        self.started = False
        self.depth = 0
        self.in_string = False
        self.escape = False
        self.pos = 0

    def feed(self, text: str) -> int | None:
        i = self.pos
        while i < len(text):
            ch = text[i]
            if not self.started:
                if ch.isspace():
                    i += 1
                    continue
                if ch == "{":
                    self.started = True
                    self.depth = 1
                    i += 1
                    continue
                i += 1
                continue

            if self.in_string:
                if self.escape:
                    self.escape = False
                elif ch == "\\":
                    self.escape = True
                elif ch == "\"":
                    self.in_string = False
                i += 1
                continue

            if ch == "\"":
                self.in_string = True
            elif ch == "{":
                self.depth += 1
            elif ch == "}":
                self.depth -= 1
                if self.depth == 0:
                    self.pos = i + 1
                    return i + 1
            i += 1

        self.pos = i
        return None


def _resolve_conversation(db: Session, req: ChatRequest) -> Conversation:
    if req.conversation_id is None:
        conversation = Conversation(title=req.message)
        db.add(conversation)
        db.flush()
        return conversation

    conversation = (
        db.query(Conversation)
        .filter(Conversation.id == req.conversation_id)
        .first()
    )
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")

    return conversation


def _get_next_sequence(db: Session, conversation_id: UUID) -> int:
    last_sequence = (
        db.query(func.max(Message.sequence_number))
        .filter(Message.conversation_id == conversation_id)
        .scalar()
    )
    return (last_sequence or 0) + 1


def _save_assistant_message(
    conversation_id: UUID,
    sequence_number: int,
    content: str,
    status: str,
) -> None:
    db = SessionLocal()
    try:
        conversation = (
            db.query(Conversation)
            .filter(Conversation.id == conversation_id)
            .first()
        )
        if not conversation:
            raise ValueError("Conversation not found while saving assistant message")

        assistant_message = Message(
            conversation_id=conversation_id,
            sequence_number=sequence_number,
            role="assistant",
            content=content,
            status=status,
        )
        db.add(assistant_message)
        conversation.message_count = (conversation.message_count or 0) + 2
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


@app.on_event("startup")
def startup():
    with engine.connect() as conn:
        conn.execute(text("CREATE SCHEMA IF NOT EXISTS heparag"))
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        conn.commit()
    Base.metadata.create_all(bind=engine)
    with engine.connect() as conn:
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS document_chunks_embedding_hnsw "
                "ON heparag.document_chunks USING hnsw (embedding vector_cosine_ops)"
            )
        )
        conn.commit()


@app.get("/")
def root():
    return {"message": "HepaRAG backend running"}


@app.get("/conversations", response_model=list[ConversationSummary])
def list_conversations(db: Session = Depends(get_db)):
    conversations = (
        db.query(Conversation)
        .order_by(Conversation.created_at.desc())
        .all()
    )
    return [
        {
            "id": conversation.id,
            "title": conversation.title,
            "message_count": conversation.message_count or 0,
        }
        for conversation in conversations
    ]


@app.get("/conversations/{conversation_id}/messages", response_model=list[ConversationMessage])
def get_conversation_messages(conversation_id: UUID, db: Session = Depends(get_db)):
    conversation = db.query(Conversation).filter(Conversation.id == conversation_id).first()
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")

    messages = (
        db.query(Message)
        .filter(Message.conversation_id == conversation_id)
        .order_by(Message.sequence_number.asc(), Message.created_at.asc())
        .all()
    )
    return [
        {
            "id": message.id,
            "role": message.role,
            "content": message.content,
            "status": message.status,
            "sequence_number": message.sequence_number,
        }
        for message in messages
    ]


@app.post("/rag/search", response_model=RagSearchResponse)
def rag_search(req: RagSearchRequest, db: Session = Depends(get_db)):
    query = req.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Query is empty")

    top_k = max(1, min(req.top_k, 50))
    candidate_k = max(top_k, min(req.candidate_k, 200))

    if req.mmr_lambda < 0 or req.mmr_lambda > 1:
        raise HTTPException(status_code=400, detail="mmr_lambda must be between 0 and 1")

    if req.min_score is not None and (req.min_score < -1 or req.min_score > 1):
        raise HTTPException(status_code=400, detail="min_score must be between -1 and 1")

    rag_logger.info(
        "rag_search query=%r top_k=%s candidate_k=%s min_score=%s mmr_lambda=%s",
        query,
        top_k,
        candidate_k,
        req.min_score,
        req.mmr_lambda,
    )

    selected = _retrieve_rag_candidates(
        db,
        query=query,
        top_k=top_k,
        candidate_k=candidate_k,
        min_score=req.min_score,
        mmr_lambda=req.mmr_lambda,
    )

    rag_logger.info(
        "rag_search selected=%s scores=%s",
        len(selected),
        [round(item["score"], 4) for item in selected[:3]],
    )

    results = [
        {
            "chunk_id": item["chunk_id"],
            "document_id": item["document_id"],
            "content": item["content"],
            "title": item["title"],
            "source": item["source"],
            "score": item["score"],
            "mmr_score": item.get("mmr_score"),
        }
        for item in selected
    ]

    return {
        "query": query,
        "top_k": top_k,
        "candidate_k": candidate_k,
        "min_score": req.min_score,
        "mmr_lambda": req.mmr_lambda,
        "results": results,
    }


@app.post("/chat", response_model=ChatResponse)
def chat(req: ChatRequest, db: Session = Depends(get_db)):
    conversation = _resolve_conversation(db, req)
    next_sequence = _get_next_sequence(db, conversation.id)

    user_message = Message(
        conversation_id=conversation.id,
        sequence_number=next_sequence,
        role="user",
        content=req.message,
        status="completed",
    )
    db.add(user_message)

    rag_prompt = req.message
    rag_sources: list[dict] = []
    if RAG_ENABLED:
        try:
            rag_results = _retrieve_rag_candidates(
                db,
                query=req.message,
                top_k=RAG_TOP_K,
                candidate_k=RAG_CANDIDATE_K,
                min_score=RAG_MIN_SCORE,
                mmr_lambda=RAG_MMR_LAMBDA,
            )
            rag_prompt = _build_rag_prompt(req.message, rag_results)
            rag_sources = _format_rag_sources(rag_results)
        except Exception as exc:
            rag_logger.exception("rag_retrieve failed in /chat: %s", exc)
            rag_prompt = req.message
            rag_sources = []
    response = generate_response(rag_prompt)
    assistant_message = Message(
        conversation_id=conversation.id,
        sequence_number=next_sequence + 1,
        role="assistant",
        content=response,
        status="completed",
    )
    db.add(assistant_message)

    conversation.message_count = (conversation.message_count or 0) + 2
    db.commit()

    return {"conversation_id": conversation.id, "response": response, "sources": rag_sources}


@app.post("/chat/stream")
def chat_stream(req: ChatRequest):
    db = SessionLocal()
    rag_sources: list[dict] = []
    try:
        conversation = _resolve_conversation(db, req)
        conversation_id = conversation.id
        next_sequence = _get_next_sequence(db, conversation_id)

        user_message = Message(
            conversation_id=conversation_id,
            sequence_number=next_sequence,
            role="user",
            content=req.message,
            status="completed",
        )
        db.add(user_message)
        db.commit()
        rag_prompt = req.message
        if RAG_ENABLED:
            try:
                rag_results = _retrieve_rag_candidates(
                    db,
                    query=req.message,
                    top_k=RAG_TOP_K,
                    candidate_k=RAG_CANDIDATE_K,
                    min_score=RAG_MIN_SCORE,
                    mmr_lambda=RAG_MMR_LAMBDA,
                )
                rag_prompt = _build_rag_prompt(req.message, rag_results)
                rag_sources = _format_rag_sources(rag_results)
            except Exception as exc:
                rag_logger.exception("rag_retrieve failed in /chat/stream: %s", exc)
                rag_prompt = req.message
                rag_sources = []

    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to start streaming chat: {exc}") from exc
    finally:
        db.close()

    def event_stream():
        full_text = ""
        detector = JsonCompletionDetector()
        saved = False
        stream_started = False

        yield _sse_event("meta", {"conversation_id": str(conversation_id)})
        yield _sse_event("status", {"status": "pending"})
        if rag_sources:
            yield _sse_event("rag", {"sources": rag_sources})

        try:
            for chunk in generate_response_stream(rag_prompt):
                token = chunk.get("choices", [{}])[0].get("text", "")
                if not token:
                    continue

                prev_len = len(full_text)
                full_text += token
                end_idx = detector.feed(full_text)

                if end_idx is not None:
                    emit_len = end_idx - prev_len
                    if emit_len > 0:
                        if not stream_started:
                            stream_started = True
                            yield _sse_event("status", {"status": "streaming"})
                        yield _sse_event("token", {"token": token[:emit_len]})

                    full_response = _sanitize_rich_response(full_text[:end_idx])
                    _save_assistant_message(
                        conversation_id=conversation_id,
                        sequence_number=next_sequence + 1,
                        content=full_response,
                        status="completed",
                    )
                    saved = True

                    yield _sse_event("status", {"status": "completed"})
                    yield _sse_event(
                        "completed",
                        {
                            "conversation_id": str(conversation_id),
                            "response": full_response,
                        },
                    )
                    return

                if not stream_started:
                    stream_started = True
                    yield _sse_event("status", {"status": "streaming"})

                yield _sse_event("token", {"token": token})

            full_response = _sanitize_rich_response(full_text)
            _save_assistant_message(
                conversation_id=conversation_id,
                sequence_number=next_sequence + 1,
                content=full_response,
                status="completed",
            )
            saved = True

            yield _sse_event("status", {"status": "completed"})
            yield _sse_event(
                "completed",
                {
                    "conversation_id": str(conversation_id),
                    "response": full_response,
                },
            )
        except Exception as exc:
            partial_response = _sanitize_rich_response(full_text)
            if not saved:
                try:
                    _save_assistant_message(
                        conversation_id=conversation_id,
                        sequence_number=next_sequence + 1,
                        content=partial_response,
                        status="failed",
                    )
                except Exception:
                    pass

            yield _sse_event("status", {"status": "failed"})
            yield _sse_event(
                "error",
                {
                    "message": str(exc),
                    "partial_response": partial_response,
                    "conversation_id": str(conversation_id),
                },
            )

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )
