/**
 * CivicLens — WIP v2 (React + TS + Vite)
 *
 * New UI polish:
 * - Length presets (Short/Medium/Long) → min_len/max_len
 * - Loading states (disable buttons, show “Summarizing…”)
 * - Live character counter (X / 8000 chars)
 * - Copy-to-clipboard for the current/last good summary
 * - Friendly error messages mapped from backend error codes
 * - Keep previous summary visible on error
 *
 * Env:
 * - VITE_API_URL (optional), defaults to http://localhost:8000
 */

import { useEffect, useMemo, useState } from "react";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

type PresetKey = "short" | "medium" | "long";
const PRESETS: Record<PresetKey, { min: number; max: number; label: string }> = {
  short:  { min: 30,  max:  90, label: "Short"  },
  medium: { min: 60,  max: 180, label: "Medium" },
  long:   { min: 90,  max: 240, label: "Long"   },
};

const ERROR_MAP: Record<string, string> = {
  FETCH_FAILED: "Could not reach the site.",
  NO_CONTENT: "Could not extract article text.",
  MODEL_FAILURE: "The summarizer ran into a constraint. Try the Short preset.",
  BAD_LENGTHS: "Chosen length is invalid for this input.",
};

export default function App() {
  const [mode, setMode] = useState<"text" | "url">("text");

  // Inputs
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");

  // Outputs
  const [summary, setSummary] = useState("");
  const [lastGoodSummary, setLastGoodSummary] = useState("");

  // UI
  const [health, setHealth] = useState<null | boolean>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [preset, setPreset] = useState<PresetKey>("medium");

  const { min, max } = PRESETS[preset];
  const charCounter = useMemo(() => `${text.length} / 8000 chars`, [text.length]);

  // Health check on mount
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${API_URL}/health`);
        const j = await r.json();
        setHealth(Boolean(j?.ok));
      } catch {
        setHealth(false);
      }
    })();
  }, []);

  async function doSummarize() {
    setError(null);
    setLoading(true);
    try {
      const r = await fetch(`${API_URL}/summarize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, min_len: min, max_len: max }),
      });
      const j = await r.json();
      if (!r.ok) throw j;
      setSummary(j.summary || "");
      setLastGoodSummary(j.summary || "");
    } catch (e: unknown) {
      const err = e as { error?: { code?: string } };
      const code = err.error?.code;
      const friendly = (code && ERROR_MAP[code]) || "Something went wrong.";
      setError(`${friendly} (${code || "UNKNOWN"})`);
    } finally {
      setLoading(false);
    }
  }

  async function doSummarizeUrl() {
    setError(null);
    setLoading(true);
    try {
      const r = await fetch(`${API_URL}/summarize-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, min_len: min, max_len: max }),
      });
      const j = await r.json();
      if (!r.ok) throw j;
      setSummary(j.summary || "");
      setLastGoodSummary(j.summary || "");
    } catch (e: unknown) {
      const err = e as { error?: { code?: string } };
      const code = err.error?.code;
      const friendly = (code && ERROR_MAP[code]) || "Something went wrong.";
      setError(`${friendly} (${code || "UNKNOWN"})`);
    } finally {
      setLoading(false);
    }
  }

  // Minimal dark styles to match your screenshot
  const card = { background: "#1f1f1f", border: "1px solid #333", borderRadius: 8, padding: 16 };
  const btn = (active: boolean) => ({
    padding: "8px 12px",
    borderRadius: 6,
    border: "1px solid #444",
    background: active ? "#2d6cdf" : "#2a2a2a",
    color: "white",
    cursor: active ? "pointer" : "not-allowed",
    opacity: active ? 1 : 0.6,
    whiteSpace: "nowrap" as const,
  });

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: "0 auto", color: "#e9e9e9", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 36, marginBottom: 8 }}>CivicLens — WIP v2</h1>
      <p style={{ color: health ? "#5ecf74" : "#e07070" }}>
        {health ? "🟢 API healthy" : health === false ? "🔴 API down" : "… checking health"}
      </p>

      {/* Mode + presets */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", margin: "16px 0" }}>
        <label><input type="radio" checked={mode === "text"} onChange={() => setMode("text")} /> Summarize Text</label>
        <label><input type="radio" checked={mode === "url"} onChange={() => setMode("url")} /> Summarize URL</label>

        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {(["short","medium","long"] as PresetKey[]).map((k) => (
            <label
              key={k}
              style={{
                ...card,
                padding: "6px 10px",
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: preset===k ? "#2a3355" : "#1f1f1f",
              }}
            >
              <input type="radio" name="preset" value={k} checked={preset===k} onChange={() => setPreset(k)} />
              {PRESETS[k].label}
            </label>
          ))}
        </div>
      </div>

      {/* Inputs */}
      {mode === "text" ? (
        <div
          style={{
            ...card,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            overflow: "hidden", // keeping children inside rounded frame
          }}
        >
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste a couple paragraphs..."
            rows={10}
            style={{
              width: "100%",
              maxWidth: "100%",
              minHeight: "12rem",
              resize: "vertical",
              boxSizing: "border-box",
              margin: 0,
              color: "e9e9e9",
              background: "2a2a2a",
              border: "1px solid #444",
              borderRadius: 6,
              padding: 12,
            }}
          />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: 12,
              color: "#aaa",
            }}
          >
            <span>{charCounter}</span>
            <button
            onClick={doSummarize}
            disabled={loading || !text.trim()}
            style={btn(!loading && !!text.trim())}
          >
            {loading ? "Summarizing..." : "Summarize"}
          </button>
        </div>
      </div>
      ) : (
        <>
          {/* URL row: flex ensures input doesn't overflow the card */}
          <div style={{ ...card, display: "flex", gap: 8, alignItems: "center" }}>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/article"
              style={{
                flex: 1, // key change: take remaining space without overflowing
                color: "#e9e9e9",
                background: "#2a2a2a",
                border: "1px solid #444",
                borderRadius: 6,
                padding: 12,
                minWidth: 0, // prevent overflow in some browsers
              }}
            />
            <button onClick={doSummarizeUrl} disabled={loading || !url.trim()} style={btn(!loading && !!url.trim())}>
              {loading ? "Summarizing…" : "Summarize URL"}
            </button>
          </div>
          <p style={{ fontSize: 12, color: "#aaa", marginTop: 4 }}>
            Preset: {PRESETS[preset].label} ({min}–{max})
          </p>
        </>
      )}

      {/* Error */}
      {error && (
        <div style={{ ...card, borderColor: "#6b2727", background: "#2a1f1f", marginTop: 12, color: "#ffb3b3" }}>
          {error}
        </div>
      )}

      {/* Output + Copy (preserves last good on error) */}
      {(summary || lastGoodSummary) && (
        <div style={{ ...card, marginTop: 16 }}>
          <h3 style={{ marginTop: 0 }}>Summary</h3>
          <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{summary || lastGoodSummary}</pre>
          <div style={{ marginTop: 10 }}>
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(summary || lastGoodSummary);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
              style={btn(true)}
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
