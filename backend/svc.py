# --- Imports ---------------------------------------------------------------
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, HttpUrl
from transformers import pipeline

import re
import httpx
import trafilatura


# --- App & Middleware ------------------------------------------------------
api = FastAPI(title="CivicLens API")

# Allow the local Vite frontend to call this API in dev.
api.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Model / Pipeline ------------------------------------------------------
MODEL_NAME = "sshleifer/distilbart-cnn-12-6"  # DistilBART fine-tuned on CNN/DM
summarizer = pipeline("summarization", model=MODEL_NAME)


# --- Data Models -----------------------------------------------------------
class SummarizeReq(BaseModel):
    """Body for /summarize: free-text summarization."""
    text: str
    max_len: int = 180
    min_len: int = 60


class SummarizeUrlReq(BaseModel):
    """Body for /summarize-url: summarize an article by URL."""
    url: HttpUrl
    max_len: int = 180
    min_len: int = 60


# --- Simple Health Check ---------------------------------------------------
@api.get("/health")
def health():
    """Liveness probe used by the frontend to confirm the API is up."""
    return {"ok": True}


# --- Free-text Summarization ----------------------------------------------
@api.post("/summarize")
def summarize(req: SummarizeReq):
    """
    Summarize raw text provided by the client.
    Returns: { "summary": str }
    """
    # guard rails
    if not req.text.strip():
        raise HTTPException(status_code=422, detail={
            "code": "EMPTY_TEXT",
            "message": "Text cannot be empty."
        })
    if not (1 <= req.min_len < req.max_len <= 300):
        raise HTTPException(status_code=422, detail={
            "code": "BAD_LENGTHS",
            "message": "min_len must be >= 1 and < max_len <= 300."
        })
    if len(req.text) > MAX_INPUT_CHARS:
        raise HTTPException(status_code=422, detail={
            "code": "TEXT_TOO_LONG",
            "message": f"Input text exceeds {MAX_INPUT_CHARS} characters."
        })

    try:
        out = summarizer(
            req.text,
            max_length=req.max_len,
            min_length=req.min_len,
            do_sample=False,
        )
        return {"summary": out[0]["summary_text"]}
    except Exception as e:
        raise HTTPException(status_code=500, detail={
            "code": "MODEL_FAILURE",
            "message": str(e)
        })


# --- URL Summarization -----------------------------------------------------
# Basic fetch/extract limits to keep requests predictable in dev.
MAX_INPUT_CHARS = 8_000
FETCH_TIMEOUT = 10.0  # seconds


def _clean_text(text: str) -> str:
    """Normalize whitespace and cap length for the model."""
    text = re.sub(r"\s+", " ", text).strip()
    return text[:MAX_INPUT_CHARS]


@api.post("/summarize-url")
async def summarize_url(req: SummarizeUrlReq):
    if not (1 <= req.min_len < req.max_len <= 300):
        raise HTTPException(
            status_code=422,
            detail={"code": "BAD_LENGTHS",
                    "message": "min_len must be >=1 and < max_len <= 300"}
    )

    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=FETCH_TIMEOUT) as client:
            r = await client.get(str(req.url), headers={"User-Agent": "CivicLens/0.1"})
            r.raise_for_status()
            html = r.text
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=422,
            detail={"code": "FETCH_FAILED", "message": f"Unable to fetch URL: {e}"}
        )

    extracted = trafilatura.extract(html, url=str(req.url)) or ""
    text = _clean_text(extracted)
    if not text or len(text.split()) < 30:
        raise HTTPException(
            status_code=422,
            detail={"code": "NO_CONTENT",
                    "message": "Could not extract article text (paywall/script-only/too short)."}
        )

    try:
        out = summarizer(text, max_length=req.max_len, min_length=req.min_len, do_sample=False)
        return {"summary": out[0]["summary_text"]}
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={"code": "MODEL_FAILURE", "message": str(e)}
        )
    
