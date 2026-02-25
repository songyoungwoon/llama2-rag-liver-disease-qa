from fastapi import FastAPI
from sqlalchemy import text
from database import engine
from models import Base

app = FastAPI()

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