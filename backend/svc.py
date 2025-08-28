"""
CivicLens backend (FastAPI)

New polish:
- Robust URL extraction with a Selectolax fallback when Trafilatura is too short
- Safer length guards for short inputs (avoid model errors)
- Concise per-request logging (CSV-ish, stdout)
- Friendly, consistent error envelopes

Notes:
- Summarizer model: sshleifer/distilbart-cnn-12-6
- URL flow: httpx fetch -> trafilatura.extract -> selectolax fallback -> summarize
- Error envelope: { "error": { "code", "message" } } with proper HTTP status
- CORS allows http://localhost:5173
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, HttpUrl

import httpx
import re
import time
from urllib.parse import urlparse

import trafilatura
from selectolax.parser import HTMLParser
from transformers import pipeline


# ---------- App & CORS ----------

api = FastAPI()

api.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  # Dev frontend (Vite)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- Model / constants ----------

# DistilBART CNN is a compact and fast summarizer; good default for current
summarizer = pipeline("summarization", model="sshleifer/distilbart-cnn-12-6")

# Hard caps to prevent excessive inputs/outputs
MAX_INPUT_CHARS = 8000
MIN_ALLOWED = 1
MAX_ALLOWED = 240


# ---------- Helpers ----------

def _now_ms() -> int:
    """Monotonic walltime in ms (stable for measuring durations)."""
    return int(time.monotonic() * 1000)


def clean_text(s: str) -> str:
    """Normalize whitespace and clamp to input character budget."""
    s = s or ""
    s = re.sub(r"\s+", " ", s).strip()
    return s[:MAX_INPUT_CHARS]


def word_count(s: str) -> int:
    return len(s.split()) if s else 0


def clamp_lengths(min_len: int, max_len: int, input_words: int) -> tuple[int, int]:
    """
    Enforce sane summary length bounds and adapt targets for short inputs.

    Rules:
      - Require 1 <= min_len < max_len <= 240
      - If the input is very short (<80 words), shrink max_len to avoid model failures:
        max_len = min(120, max(40, int(words * 1.2)))
      - Try to keep at least ~10 tokens gap if possible
      - Raise BAD_LENGTHS (422) if still impossible
    """
    if min_len is None or max_len is None:
        raise HTTPException(
            status_code=422,
            detail={"error": {"code": "BAD_LENGTHS", "message": "min_len and max_len are required"}},
        )
    try:
        min_len = int(min_len)
        max_len = int(max_len)
    except Exception:
        raise HTTPException(
            status_code=422,
            detail={"error": {"code": "BAD_LENGTHS", "message": "Lengths must be integers"}},
        )

    # Clamp within absolute bounds; ensure a strict inequality
    if not (MIN_ALLOWED <= min_len < max_len <= MAX_ALLOWED):
        min_len = max(MIN_ALLOWED, min_len)
        max_len = min(MAX_ALLOWED, max_len)
        if not (min_len < max_len):
            raise HTTPException(
                status_code=422,
                detail={"error": {"code": "BAD_LENGTHS", "message": "Invalid bounds"}},
            )

    # Adapt for short inputs to avoid over-asking the model
    if input_words < 80:
        new_max = min(120, max(40, int(input_words * 1.2)))
        max_len = min(max_len, new_max)
        if max_len < 2:
            max_len = 2
        # Keep a cushion if possible
        min_len = min(min_len, max_len - 10) if max_len - 10 >= MIN_ALLOWED else MIN_ALLOWED

        if not (MIN_ALLOWED <= min_len < max_len <= MAX_ALLOWED):
            raise HTTPException(
                status_code=422,
                detail={"error": {"code": "BAD_LENGTHS", "message": "Chosen length is invalid for this input"}},
            )

    return min_len, max_len


def extract_trafilatura(html: str) -> str:
    """Primary extraction path (best-effort)."""
    if not html:
        return ""
    txt = trafilatura.extract(html) or ""
    return clean_text(txt)


def extract_selectolax(html: str) -> str:
    """
    Simple readability fallback:
    - Strip clearly non-content tags
    - Stitch visible <p> text (prefers <article> or <main>)
    """
    if not html:
        return ""
    tree = HTMLParser(html)

    # Drop likely-noise containers
    for sel in ("script", "style", "noscript", "template", "header", "footer", "nav", "aside"):
        for n in tree.css(sel):
            n.decompose()

    parts: list[str] = []
    for p in tree.css("article p, main p, p"):
        t = (p.text() or "").strip()
        # Require minimal length to avoid nav crumbs, captions, etc.
        if t and len(t.split()) >= 3:
            parts.append(t)
        if len(" ".join(parts)) > MAX_INPUT_CHARS:
            break

    return clean_text(" ".join(parts))


# ---------- Schemas ----------

class SummarizeBody(BaseModel):
    text: str
    min_len: int = 60
    max_len: int = 180


class SummarizeUrlBody(BaseModel):
    url: HttpUrl
    min_len: int = 60
    max_len: int = 180


# ---------- Endpoints ----------

@api.get("/health")
def health():
    """Simple liveness check used by the frontend."""
    return {"ok": True}


@api.post("/summarize")
def summarize(b: SummarizeBody):
    """
    Summarize raw text.
    - Validates/clamps length targets (min_len/max_len)
    - Logs minimal request metrics
    """
    start = _now_ms()
    endpoint = "summarize"

    text = clean_text(b.text or "")
    if not text:
        code = "NO_CONTENT"
        # CSV-ish: start,endpoint,http_status,fields...,error_code
        print(f"{start},{endpoint},422,text_len=0,words=0,fetch_ms=0,extract_ms=0,summarize_ms=0,error={code}")
        raise HTTPException(status_code=422, detail={"error": {"code": code, "message": "No text provided"}})

    words = word_count(text)
    min_len, max_len = clamp_lengths(b.min_len, b.max_len, words)

    try:
        t0 = _now_ms()
        out = summarizer(text, min_length=min_len, max_length=max_len)[0]["summary_text"]
        summarize_ms = _now_ms() - t0
        print(f"{start},{endpoint},200,text_len={len(text)},words={words},fetch_ms=0,extract_ms=0,summarize_ms={summarize_ms},error=")
        return {"summary": out}
    except HTTPException:
        # Already well-formed; just bubble up.
        raise
    except Exception:
        code = "MODEL_FAILURE"
        print(f"{start},{endpoint},500,text_len={len(text)},words={words},fetch_ms=0,extract_ms=0,summarize_ms=0,error={code}")
        raise HTTPException(
            status_code=500,
            detail={"error": {"code": code, "message": "The summarizer failed."}},
        )


@api.post("/summarize-url")
async def summarize_url(b: SummarizeUrlBody):
    """
    Summarize content from a URL.
    Steps:
      1) Fetch HTML via httpx (10s timeout)
      2) Try trafilatura.extract; if too short, fallback to selectolax <p> stitching
      3) Clamp lengths and summarize
      4) Log concise metrics (fetch/extract/summarize ms)
    Errors:
      - 502 FETCH_FAILED when site is unreachable
      - 422 NO_CONTENT when readable text cannot be extracted
      - 500 MODEL_FAILURE when the model fails
    """
    start = _now_ms()
    endpoint = "summarize-url"
    host = urlparse(str(b.url)).netloc
    fetch_ms = extract_ms = summarize_ms = 0

    # Fetch
    try:
        t0 = _now_ms()
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(str(b.url))
            resp.raise_for_status()
            html = resp.text
        fetch_ms = _now_ms() - t0
    except Exception:
        code = "FETCH_FAILED"
        print(f"{start},{endpoint},502,host={host},words=0,fetch_ms={fetch_ms},extract_ms=0,summarize_ms=0,error={code}")
        raise HTTPException(
            status_code=502,
            detail={"error": {"code": code, "message": "Could not reach the site."}},
        )

    # Extract
    t1 = _now_ms()
    text = extract_trafilatura(html)
    words = word_count(text)
    if words < 30:
        # Fallback readability stitch if primary extractor is too short
        text = extract_selectolax(html)
        words = word_count(text)
    extract_ms = _now_ms() - t1

    if words < 30:
        code = "NO_CONTENT"
        print(f"{start},{endpoint},422,host={host},words={words},fetch_ms={fetch_ms},extract_ms={extract_ms},summarize_ms=0,error={code}")
        raise HTTPException(
            status_code=422,
            detail={"error": {"code": code, "message": "Could not extract article text."}},
        )

    text = clean_text(text)
    min_len, max_len = clamp_lengths(b.min_len, b.max_len, words)

    # Summarize
    try:
        t2 = _now_ms()
        out = summarizer(text, min_length=min_len, max_length=max_len)[0]["summary_text"]
        summarize_ms = _now_ms() - t2
        print(f"{start},{endpoint},200,host={host},words={words},fetch_ms={fetch_ms},extract_ms={extract_ms},summarize_ms={summarize_ms},error=")
        return {"summary": out}
    except HTTPException:
        raise
    except Exception:
        code = "MODEL_FAILURE"
        print(f"{start},{endpoint},500,host={host},words={words},fetch_ms={fetch_ms},extract_ms={extract_ms},summarize_ms=0,error={code}")
        raise HTTPException(
            status_code=500,
            detail={"error": {"code": code, "message": "The summarizer ran into a constraint. Try the Short preset."}}
        )
