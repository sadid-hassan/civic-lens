"""
CivicLens backend (FastAPI)

New features:
- Robust URL extraction with Trafilatura + Selectolax fallback
- Safer length guards for short inputs
- Structured JSON logs per request (no secrets)
- Optional response metrics when CIVICLENS_DEBUG=1
- Env-switchable summarizer model:
    CIVICLENS_MODEL=distilbart|bart-large
- Lightweight in-memory rate limit (per IP / X-Forwarded-For):
    CIVICLENS_RATE_LIMIT="60/1"  # 60 requests / minute
- Endpoints:
    /health, /summarize, /summarize-url, /summarize-html, /feedback
- CORS allows http://localhost:5173 (dev frontend)
"""

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, HttpUrl

import os
import json
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
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- Model / Env ----------

# Switchable summarizer via env (fast vs higher quality)
MODEL_FLAG = (os.getenv("CIVICLENS_MODEL") or "distilbart").strip().lower()
if MODEL_FLAG == "bart-large":
    MODEL_NAME = "facebook/bart-large-cnn"
else:
    MODEL_FLAG = "distilbart"
    MODEL_NAME = "sshleifer/distilbart-cnn-12-6"

# Initialize once at startup
summarizer = pipeline("summarization", model=MODEL_NAME)

# Optional: include metrics in JSON responses
DEBUG_RESP = os.getenv("CIVICLENS_DEBUG") == "1"

# Simple in-memory rate limit (per process)
# Ex: "60/1" => 60 requests per 1 minute
_rl_cfg = (os.getenv("CIVICLENS_RATE_LIMIT") or "60/1").split("/")
try:
    RL_MAX = max(1, int(_rl_cfg[0]))
    RL_MINUTES = max(1, int(_rl_cfg[1]))
except Exception:
    RL_MAX, RL_MINUTES = 60, 1
RL_REFILL_PER_SEC = RL_MAX / (RL_MINUTES * 60.0)
_rl_buckets: dict[str, dict[str, float]] = {}  # ip -> {"tokens": float, "ts": float}

# Hard caps to protect resources
MAX_INPUT_CHARS = 8000
MIN_ALLOWED = 1
MAX_ALLOWED = 240


# ---------- Utilities ----------

def _now_ms() -> int:
    return int(time.monotonic() * 1000)


def _now_s() -> float:
    return time.monotonic()


def client_ip(req: Request) -> str:
    """Pick first X-Forwarded-For IP if present; fall back to client.host."""
    fwd = req.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return req.client.host if req.client else "unknown"


def rl_allow(ip: str) -> tuple[bool, float]:
    """Token-bucket limiter per IP. Returns (allowed, retry_after_seconds)."""
    now = _now_s()
    b = _rl_buckets.get(ip)
    if not b:
        _rl_buckets[ip] = {"tokens": RL_MAX - 1, "ts": now}
        return True, 0.0
    # Refill based on elapsed time
    elapsed = max(0.0, now - b["ts"])
    b["tokens"] = min(RL_MAX, b["tokens"] + elapsed * RL_REFILL_PER_SEC)
    b["ts"] = now
    if b["tokens"] >= 1.0:
        b["tokens"] -= 1.0
        return True, 0.0
    missing = 1.0 - b["tokens"]
    retry = missing / RL_REFILL_PER_SEC if RL_REFILL_PER_SEC > 0 else 60.0
    return False, max(1.0, retry)


def log_json(**fields):
    """Emit a single structured JSON line; keep values safe and bounded."""
    for k, v in list(fields.items()):
        if isinstance(v, (bytes, bytearray)) or (isinstance(v, str) and len(v) > 500):
            fields[k] = str(v)[:500]
    fields.setdefault("ts", _now_ms())
    print(json.dumps(fields, ensure_ascii=False))


def clean_text(s: str) -> str:
    """Normalize whitespace and clamp to input char budget."""
    s = s or ""
    s = re.sub(r"\s+", " ", s).strip()
    return s[:MAX_INPUT_CHARS]


def word_count(s: str) -> int:
    return len(s.split()) if s else 0


def clamp_lengths(min_len: int, max_len: int, input_words: int) -> tuple[int, int]:
    """
    Enforce sane summary length bounds and adapt for very short inputs.

    Rules:
      - Require 1 <= min_len < max_len <= 240
      - If input is short (<80 words), shrink max_len to a safe range:
        max_len = min(120, max(40, int(words * 1.2)))
      - Keep at least ~10 tokens gap if possible
      - Raise BAD_LENGTHS (422) if impossible
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

    if not (MIN_ALLOWED <= min_len < max_len <= MAX_ALLOWED):
        min_len = max(MIN_ALLOWED, min_len)
        max_len = min(MAX_ALLOWED, max_len)
        if not (min_len < max_len):
            raise HTTPException(
                status_code=422,
                detail={"error": {"code": "BAD_LENGTHS", "message": "Invalid bounds"}},
            )

    if input_words < 80:
        new_max = min(120, max(40, int(input_words * 1.2)))
        max_len = min(max_len, new_max)
        if max_len < 2:
            max_len = 2
        min_len = min(min_len, max_len - 10) if max_len - 10 >= MIN_ALLOWED else MIN_ALLOWED

        if not (MIN_ALLOWED <= min_len < max_len <= MAX_ALLOWED):
            raise HTTPException(
                status_code=422,
                detail={"error": {"code": "BAD_LENGTHS", "message": "Chosen length is invalid for this input"}},
            )

    return min_len, max_len


def extract_trafilatura(html: str) -> str:
    """Primary extraction path."""
    if not html:
        return ""
    txt = trafilatura.extract(html) or ""
    return clean_text(txt)


def extract_selectolax(html: str) -> str:
    """Fallback extractor: stitch visible <p> text (prefers article/main)."""
    if not html:
        return ""
    tree = HTMLParser(html)
    # Drop obvious noise
    for sel in ("script", "style", "noscript", "template", "header", "footer", "nav", "aside"):
        for n in tree.css(sel):
            n.decompose()

    parts: list[str] = []
    for p in tree.css("article p, main p, p"):
        t = (p.text() or "").strip()
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


class SummarizeHtmlBody(BaseModel):
    html: str
    min_len: int = 60
    max_len: int = 180


class FeedbackBody(BaseModel):
    mode: str  # "text" | "url"
    liked: bool
    len_preset: str | None = None
    url: str | None = None


# ---------- Endpoints ----------

@api.get("/health")
def health():
    return {"ok": True}


@api.post("/summarize")
def summarize(b: SummarizeBody, request: Request):
    endpoint = "summarize"
    ip = client_ip(request)

    allowed, retry = rl_allow(ip)
    if not allowed:
        log_json(endpoint=endpoint, status=429, ip=ip, error="RATE_LIMIT", rl_allowed=False)
        raise HTTPException(
            status_code=429,
            headers={"Retry-After": str(int(retry))},
            detail={"error": {"code": "RATE_LIMIT", "message": "Too many requests"}},
        )

    text = clean_text(b.text or "")
    if not text:
        code = "NO_CONTENT"
        log_json(endpoint=endpoint, status=422, ip=ip, text_len=0, words=0,
                 fetch_ms=0, extract_ms=0, summarize_ms=0, model=MODEL_FLAG,
                 error=code, rl_allowed=True)
        raise HTTPException(status_code=422, detail={"error": {"code": code, "message": "No text provided"}})

    words = word_count(text)
    min_len, max_len = clamp_lengths(b.min_len, b.max_len, words)

    try:
        t0 = _now_ms()
        out = summarizer(text, min_length=min_len, max_length=max_len)[0]["summary_text"]
        summarize_ms = _now_ms() - t0
        log_json(endpoint=endpoint, status=200, ip=ip, text_len=len(text), words=words,
                 fetch_ms=0, extract_ms=0, summarize_ms=summarize_ms, model=MODEL_FLAG,
                 error=None, rl_allowed=True)
        resp = {"summary": out}
        if DEBUG_RESP:
            resp["metrics"] = {"words": words, "fetch_ms": 0, "extract_ms": 0,
                               "summarize_ms": summarize_ms, "model": MODEL_FLAG}
        return resp
    except HTTPException:
        raise
    except Exception:
        code = "MODEL_FAILURE"
        log_json(endpoint=endpoint, status=500, ip=ip, text_len=len(text), words=words,
                 fetch_ms=0, extract_ms=0, summarize_ms=0, model=MODEL_FLAG,
                 error=code, rl_allowed=True)
        raise HTTPException(status_code=500, detail={"error": {"code": code, "message": "The summarizer failed."}})


@api.post("/summarize-url")
async def summarize_url(b: SummarizeUrlBody, request: Request):
    endpoint = "summarize-url"
    ip = client_ip(request)

    allowed, retry = rl_allow(ip)
    if not allowed:
        log_json(endpoint=endpoint, status=429, ip=ip, error="RATE_LIMIT", rl_allowed=False)
        raise HTTPException(
            status_code=429,
            headers={"Retry-After": str(int(retry))},
            detail={"error": {"code": "RATE_LIMIT", "message": "Too many requests"}},
        )

    host = urlparse(str(b.url)).netloc
    fetch_ms = extract_ms = summarize_ms = 0

    # 1) Fetch HTML (browser-like headers to avoid basic bot blocks)
    try:
        t0 = _now_ms()
        async with httpx.AsyncClient(
            timeout=15,
            follow_redirects=True,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            },
        ) as client:
            resp = await client.get(str(b.url))
            resp.raise_for_status()
            html = resp.text
        fetch_ms = _now_ms() - t0
    except Exception:
        code = "FETCH_FAILED"
        log_json(endpoint=endpoint, status=502, ip=ip, host=host, words=0,
                 fetch_ms=fetch_ms, extract_ms=0, summarize_ms=0, model=MODEL_FLAG,
                 error=code, rl_allowed=True)
        raise HTTPException(status_code=502, detail={"error": {"code": code, "message": "Could not reach the site."}})

    # 2) Extract readable text (with fallback)
    t1 = _now_ms()
    text = extract_trafilatura(html)
    words = word_count(text)
    if words < 30:
        text = extract_selectolax(html)
        words = word_count(text)
    extract_ms = _now_ms() - t1

    if words < 30:
        code = "NO_CONTENT"
        log_json(endpoint=endpoint, status=422, ip=ip, host=host, words=words,
                 fetch_ms=fetch_ms, extract_ms=extract_ms, summarize_ms=0, model=MODEL_FLAG,
                 error=code, rl_allowed=True)
        raise HTTPException(status_code=422, detail={"error": {"code": code, "message": "Could not extract article text."}})

    # 3) Summarize
    text = clean_text(text)
    min_len, max_len = clamp_lengths(b.min_len, b.max_len, words)

    try:
        t2 = _now_ms()
        out = summarizer(text, min_length=min_len, max_length=max_len)[0]["summary_text"]
        summarize_ms = _now_ms() - t2
        log_json(endpoint=endpoint, status=200, ip=ip, host=host, words=words,
                 fetch_ms=fetch_ms, extract_ms=extract_ms, summarize_ms=summarize_ms, model=MODEL_FLAG,
                 error=None, rl_allowed=True)
        resp = {"summary": out}
        if DEBUG_RESP:
            resp["metrics"] = {"words": words, "fetch_ms": fetch_ms, "extract_ms": extract_ms,
                               "summarize_ms": summarize_ms, "model": MODEL_FLAG}
        return resp
    except HTTPException:
        raise
    except Exception:
        code = "MODEL_FAILURE"
        log_json(endpoint=endpoint, status=500, ip=ip, host=host, words=words,
                 fetch_ms=fetch_ms, extract_ms=extract_ms, summarize_ms=0, model=MODEL_FLAG,
                 error=code, rl_allowed=True)
        raise HTTPException(status_code=500, detail={"error": {"code": code, "message": "The summarizer ran into a constraint. Try the Short preset."}})


@api.post("/summarize-html")
def summarize_html(b: SummarizeHtmlBody, request: Request):
    """Summarize content directly from raw HTML (no network fetch)."""
    endpoint = "summarize-html"
    ip = client_ip(request)

    allowed, retry = rl_allow(ip)
    if not allowed:
        log_json(endpoint=endpoint, status=429, ip=ip, error="RATE_LIMIT", rl_allowed=False)
        raise HTTPException(
            status_code=429,
            headers={"Retry-After": str(int(retry))},
            detail={"error": {"code": "RATE_LIMIT", "message": "Too many requests"}},
        )

    extract_ms = summarize_ms = 0

    # Extract readable text
    t1 = _now_ms()
    text = extract_trafilatura(b.html or "")
    words = word_count(text)
    if words < 30:
        text = extract_selectolax(b.html or "")
        words = word_count(text)
    extract_ms = _now_ms() - t1

    if words < 30:
        code = "NO_CONTENT"
        log_json(endpoint=endpoint, status=422, ip=ip, words=words,
                 fetch_ms=0, extract_ms=extract_ms, summarize_ms=0, model=MODEL_FLAG,
                 error=code, rl_allowed=True)
        raise HTTPException(status_code=422, detail={"error": {"code": code, "message": "Could not extract article text."}})

    text = clean_text(text)
    min_len, max_len = clamp_lengths(b.min_len, b.max_len, words)

    try:
        t2 = _now_ms()
        out = summarizer(text, min_length=min_len, max_length=max_len)[0]["summary_text"]
        summarize_ms = _now_ms() - t2
        log_json(endpoint=endpoint, status=200, ip=ip, words=words,
                 fetch_ms=0, extract_ms=extract_ms, summarize_ms=summarize_ms, model=MODEL_FLAG,
                 error=None, rl_allowed=True)
        resp = {"summary": out}
        if DEBUG_RESP:
            resp["metrics"] = {"words": words, "fetch_ms": 0, "extract_ms": extract_ms,
                               "summarize_ms": summarize_ms, "model": MODEL_FLAG}
        return resp
    except Exception:
        code = "MODEL_FAILURE"
        log_json(endpoint=endpoint, status=500, ip=ip, words=words,
                 fetch_ms=0, extract_ms=extract_ms, summarize_ms=0, model=MODEL_FLAG,
                 error=code, rl_allowed=True)
        raise HTTPException(status_code=500, detail={"error": {"code": code, "message": "The summarizer failed."}})


@api.post("/feedback", status_code=204)
def feedback(b: FeedbackBody, request: Request):
    """Thumbs up/down capture (fire-and-forget)."""
    ip = client_ip(request)
    ua = request.headers.get("user-agent", "")
    log_json(type="feedback", ip=ip, ua=ua, mode=b.mode, liked=b.liked,
             len_preset=b.len_preset, url=b.url)
    return
