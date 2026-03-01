from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from database import SessionLocal, engine
from llm import generate_response
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
    if req.conversation_id is None:
        conversation = Conversation(title=req.message)
        db.add(conversation)
        db.flush()
    else:
        conversation = (
            db.query(Conversation)
            .filter(Conversation.id == req.conversation_id)
            .first()
        )
        if not conversation:
            raise HTTPException(status_code=404, detail="Conversation not found")

    last_sequence = (
        db.query(func.max(Message.sequence_number))
        .filter(Message.conversation_id == conversation.id)
        .scalar()
    )
    next_sequence = (last_sequence or 0) + 1

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

    return {
        "conversation_id": conversation.id,
        "response": response,
    }
