import json
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from database import SessionLocal, engine
from llm import generate_response, generate_response_stream
from models import Base, Conversation, Message

app = FastAPI()

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


class ChatResponse(BaseModel):
    conversation_id: UUID
    response: str


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


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _sse_event(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


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

    response = generate_response(req.message)
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

    return {"conversation_id": conversation.id, "response": response}


@app.post("/chat/stream")
def chat_stream(req: ChatRequest):
    db = SessionLocal()
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
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to start streaming chat: {exc}") from exc
    finally:
        db.close()

    def event_stream():
        chunks: list[str] = []
        saved = False
        stream_started = False

        yield _sse_event("meta", {"conversation_id": str(conversation_id)})
        yield _sse_event("status", {"status": "pending"})

        try:
            for chunk in generate_response_stream(req.message):
                token = chunk.get("choices", [{}])[0].get("text", "")
                if not token:
                    continue

                if not stream_started:
                    stream_started = True
                    yield _sse_event("status", {"status": "streaming"})

                chunks.append(token)
                yield _sse_event("token", {"token": token})

            full_response = "".join(chunks)
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
            partial_response = "".join(chunks)
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
