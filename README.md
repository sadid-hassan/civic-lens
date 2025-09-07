# CivicLens

CivicLens is a lightweight web app for summarizing text and URLs. It combines a **FastAPI backend** with a **React + Vite frontend**, powered by Hugging Face summarization models.


**⚠️Note: Under Development**:
This project is still in progress and not feature-complete. Expect new functionality and refinements in upcoming versions as I continue to work on it.

## Features
- Summarize text or URLs with configurable length
- AMP fallback and caching for more reliable URL extraction
- Batch summarization endpoint
- Debug logs endpoint (when enabled)
- Persistent settings, history panel, and summary export
- Toast notifications and accessibility polish

## Requirements
- Python 3.10+ with `venv`
- Node.js 18+ and npm

## Setup

### Backend
```powershell
# from repo root
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install "uvicorn[standard]" fastapi httpx transformers torch selectolax

# environment variables
$env:CIVICLENS_MODEL = "distilbart"
$env:CIVICLENS_DEBUG = "1"
$env:CIVICLENS_CACHE_TTL = "300"
$env:CIVICLENS_ENABLE_AMP = "0"

# run (repo root)
uvicorn backend.svc:api --reload --port 8000
```

### Frontend
```
cd frontend/web
npm install
$env:VITE_API_URL = "http://localhost:8000"
npm run dev
```

Visit the frontend at http://localhost:5173 and the API docs at http://localhost:8000/docs

