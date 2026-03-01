from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from database import engine
from models import Base
from pydantic import BaseModel
from llm import generate_response

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

@app.post("/chat")
def chat(req: ChatRequest):
    response = generate_response(req.message)
    return {"response": response}
