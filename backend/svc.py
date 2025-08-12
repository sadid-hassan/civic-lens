from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from transformers import pipeline

api = FastAPI(title="CivicLens API")

api.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173","http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

summarizer = pipeline("summarization", model="sshleifer/distilbart-cnn-12-6")

class SummarizeReq(BaseModel):
    text: str
    max_len: int = 180
    min_len: int = 60

@api.get("/health")
def health():
    return {"ok": True}

@api.post("/summarize")
def summarize(req: SummarizeReq):
    out = summarizer(req.text, max_length=req.max_len, min_length=req.min_len, do_sample=False)
    return {"summary": out[0]["summary_text"]}
