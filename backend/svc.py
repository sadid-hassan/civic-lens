# --- Imports ---------------------------------------------------------------
from fastapi import FastAPI
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

    Returns
    -------
    { "summary": str }
    """
    out = summarizer(
        req.text,
        max_length=req.max_len,
        min_length=req.min_len,
        do_sample=False,
    )
    return {"summary": out[0]["summary_text"]}


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
    """
    Fetch a web page, extract main article text, and summarize it.

    Flow
    ----
    1) Validate requested output lengths.
    2) Fetch URL with a small timeout (follow redirects).
    3) Extract readable article text with `trafilatura`.
    4) Clean/truncate text and run the summarizer.
    5) Return { "summary": ... } or a structured error.

    Notes
    -----
    - Extraction can fail on paywalls / script-only pages.
    - In production, prefer raising `HTTPException` for status codes.
    """
    # (1) quick guard on generation lengths
    if not (1 <= req.min_len < req.max_len <= 300):
        return {
            "error": {
                "code": "BAD_LENGTHS",
                "message": "min_len must be >=1 and < max_len <= 300",
            }
        }, 422

    # (2) fetch HTML
    try:
        async with httpx.AsyncClient(
            follow_redirects=True, timeout=FETCH_TIMEOUT
        ) as client:
            r = await client.get(str(req.url), headers={"User-Agent": "CivicLens/0.1"})
            r.raise_for_status()
            html = r.text
    except httpx.HTTPError as e:
        return {
            "error": {"code": "FETCH_FAILED", "message": f"Unable to fetch URL: {e}"}
        }, 422

    # (3) extract readable text
    extracted = trafilatura.extract(html, url=str(req.url)) or ""
    text = _clean_text(extracted)

    if not text or len(text.split()) < 30:
        return {
            "error": {
                "code": "NO_CONTENT",
                "message": "Could not extract article text (paywall/script-only/too short).",
            }
        }, 422

    # (4) summarize
    try:
        out = summarizer(
            text,
            max_length=req.max_len,
            min_length=req.min_len,
            do_sample=False,
        )
        return {"summary": out[0]["summary_text"]}
    except Exception as e:
        # Model/runtime failure
        return {"error": {"code": "MODEL_FAILURE", "message": str(e)}}, 500
