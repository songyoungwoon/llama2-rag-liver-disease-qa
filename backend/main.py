from fastapi import FastAPI
from sqlalchemy import text
from database import engine
from models import Base
from pydantic import BaseModel
from llm import generate_response

app = FastAPI()

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