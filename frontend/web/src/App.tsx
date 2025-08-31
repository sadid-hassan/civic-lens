/**
 * CivicLens — WIP v2 (React + TS + Vite)
 *
 * New features:
 * - Length presets (Short/Medium/Long) OR custom numeric lengths
 * - Settings panel (Fast vs Accurate model; presets vs custom)
 * - Loading states, live character counter, copy-to-clipboard
 * - Friendly error messages; keep last good summary on error
 * - Metrics caption when backend sets CIVICLENS_DEBUG=1
 * - Thumbs up/down feedback (fire-and-forget to /feedback)
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
  RATE_LIMIT: "Too many requests. Please wait a moment and try again.",
};

// ---- API response types (avoid `any`) ----
type Metrics = {
  fetch_ms?: number;
  extract_ms?: number;
  summarize_ms?: number;
  model?: string;
  words?: number;
};
type SummaryResponse = {
  summary?: string;
  metrics?: Metrics;
};
type ErrorEnvelope = {
  error?: { code?: string; message?: string };
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

  // Settings
  const [showSettings, setShowSettings] = useState(false);
  const [preset, setPreset] = useState<PresetKey>("medium");
  const [lengthMode, setLengthMode] = useState<"presets" | "custom">("presets");
  const [customMin, setCustomMin] = useState<number>(60);
  const [customMax, setCustomMax] = useState<number>(180);
  const [modelChoice, setModelChoice] = useState<"fast" | "accurate">("fast");

  // Optional metrics from backend (when CIVICLENS_DEBUG=1)
  const [lastMetrics, setLastMetrics] = useState<Metrics | null>(null);

  const { min, max } = PRESETS[preset];
  const effectiveMin = lengthMode === "presets" ? min : Math.max(1, Math.min(240, customMin || 1));
  const effectiveMax = lengthMode === "presets" ? max : Math.max(1, Math.min(240, customMax || 1));
  const modelHeader = modelChoice === "accurate" ? "bart-large" : "distilbart";

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
    setError(null); setLoading(true);
    try {
      const r = await fetch(`${API_URL}/summarize`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Model": modelHeader },
        body: JSON.stringify({ text, min_len: effectiveMin, max_len: effectiveMax }),
      });
      let j: unknown = null;
      try { j = await r.json(); } catch { /* non-JSON error page */ }
      if (!r.ok) {
        const err = (j as ErrorEnvelope) ?? { error: { code: "UNKNOWN" } };
        throw err;
      }
      const data = (j as SummaryResponse) ?? {};
      setSummary(data.summary || "");
      setLastGoodSummary(data.summary || "");
      setLastMetrics(data.metrics ?? null);
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
    setError(null); setLoading(true);
    try {
      const r = await fetch(`${API_URL}/summarize-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Model": modelHeader },
        body: JSON.stringify({ url, min_len: effectiveMin, max_len: effectiveMax }),
      });
      let j: unknown = null;
      try { j = await r.json(); } catch { /* non-JSON error page */ }
      if (!r.ok) {
        const err = (j as ErrorEnvelope) ?? { error: { code: "UNKNOWN" } };
        throw err;
      }
      const data = (j as SummaryResponse) ?? {};
      setSummary(data.summary || "");
      setLastGoodSummary(data.summary || "");
      setLastMetrics(data.metrics ?? null);
    } catch (e: unknown) {
      const err = e as { error?: { code?: string } };
      const code = err.error?.code;
      const friendly = (code && ERROR_MAP[code]) || "Something went wrong.";
      setError(`${friendly} (${code || "UNKNOWN"})`);
    } finally {
      setLoading(false);
    }
  }

  // Minimal dark styles
  const card = { background: "#1f1f1f", border: "1px solid #333", borderRadius: 8, padding: 16 };
  const btn = (enabled: boolean) => ({
    padding: "8px 12px",
    borderRadius: 6,
    border: "1px solid #444",
    background: enabled ? "#2d6cdf" : "#2a2a2a",
    color: "white",
    cursor: enabled ? "pointer" : "not-allowed",
    opacity: enabled ? 1 : 0.6,
    whiteSpace: "nowrap" as const,
  });

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: "0 auto", color: "#e9e9e9", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 36, marginBottom: 8 }}>CivicLens — WIP v2</h1>
      <p style={{ color: health ? "#5ecf74" : "#e07070" }}>
        {health ? "🟢 API healthy" : health === false ? "🔴 API down" : "… checking health"}
      </p>

      {/* Mode + presets + settings toggle */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", margin: "16px 0" }}>
        <label><input type="radio" checked={mode === "text"} onChange={() => setMode("text")} /> Summarize Text</label>
        <label><input type="radio" checked={mode === "url"} onChange={() => setMode("url")} /> Summarize URL</label>

        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button onClick={() => setShowSettings(s => !s)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #444", background: "#2a2a2a", color: "#fff" }}>
            {showSettings ? "Close Settings" : "Settings"}
          </button>
          {(["short","medium","long"] as PresetKey[]).map((k) => (
            <label
              key={k}
              style={{
                ...card,
                padding: "6px 10px",
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: preset===k && lengthMode==="presets" ? "#2a3355" : "#1f1f1f",
              }}
            >
              <input
                type="radio"
                name="preset"
                value={k}
                checked={preset===k && lengthMode==="presets"}
                onChange={() => { setLengthMode("presets"); setPreset(k); }}
              />
              {PRESETS[k].label}
            </label>
          ))}
        </div>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div style={{ ...card, marginBottom: 12 }}>
          <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Model</div>
              <label style={{ marginRight: 12 }}>
                <input type="radio" checked={modelChoice==="fast"} onChange={() => setModelChoice("fast")} /> Fast
              </label>
              <label>
                <input type="radio" checked={modelChoice==="accurate"} onChange={() => setModelChoice("accurate")} /> Accurate
              </label>
            </div>
            <div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Length</div>
              <label style={{ marginRight: 12 }}>
                <input type="radio" checked={lengthMode==="presets"} onChange={() => setLengthMode("presets")} /> Presets
              </label>
              <label>
                <input type="radio" checked={lengthMode==="custom"} onChange={() => setLengthMode("custom")} /> Custom
              </label>
            </div>
            {lengthMode === "custom" && (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="number" min={1} max={240} value={customMin}
                  onChange={(e)=>setCustomMin(parseInt(e.target.value||"1"))}
                  style={{ width: 80, background:"#2a2a2a", color:"#fff", border:"1px solid #444", borderRadius:6, padding:6 }} />
                <span>to</span>
                <input type="number" min={1} max={240} value={customMax}
                  onChange={(e)=>setCustomMax(parseInt(e.target.value||"1"))}
                  style={{ width: 80, background:"#2a2a2a", color:"#fff", border:"1px solid #444", borderRadius:6, padding:6 }} />
              </div>
            )}
            <div style={{ marginLeft: "auto", opacity: 0.9 }}>
              <span style={{ padding: "4px 8px", border: "1px solid #444", borderRadius: 6 }}>
                Mode: {modelChoice === "fast" ? "Fast" : "Accurate"}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Inputs */}
      {mode === "text" ? (
        <div style={{ ...card, display: "flex", flexDirection: "column", gap: 8, overflow: "hidden" }}>
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
              color: "#e9e9e9",
              background: "#2a2a2a",
              border: "1px solid #444",
              borderRadius: 6,
              padding: 12,
            }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "#aaa" }}>
            <span>{charCounter}</span>
            <button onClick={doSummarize} disabled={loading || !text.trim()} style={btn(!loading && !!text.trim())}>
              {loading ? "Summarizing…" : "Summarize"}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ ...card, display: "flex", gap: 8, alignItems: "center" }}>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/article"
              style={{
                flex: 1,
                minWidth: 0,
                color: "#e9e9e9",
                background: "#2a2a2a",
                border: "1px solid #444",
                borderRadius: 6,
                padding: 12,
              }}
            />
            <button onClick={doSummarizeUrl} disabled={loading || !url.trim()} style={btn(!loading && !!url.trim())}>
              {loading ? "Summarizing…" : "Summarize URL"}
            </button>
          </div>
          <p style={{ fontSize: 12, color: "#aaa", marginTop: 4 }}>
            {lengthMode === "presets"
              ? <>Preset: {PRESETS[preset].label} ({min}–{max})</>
              : <>Custom: {effectiveMin}–{effectiveMax}</>}
          </p>
        </>
      )}

      {/* Error */}
      {error && (
        <div style={{ ...card, borderColor: "#6b2727", background: "#2a1f1f", marginTop: 12, color: "#ffb3b3" }}>
          {error}
        </div>
      )}

      {/* Output + Copy + Feedback + Metrics */}
      {(summary || lastGoodSummary) && (
        <div style={{ ...card, marginTop: 16 }}>
          <h3 style={{ marginTop: 0 }}>Summary</h3>
          <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{summary || lastGoodSummary}</pre>

          {lastMetrics && (
            <div style={{ marginTop: 6, fontSize: 12, color: "#aaa" }}>
              {[
                lastMetrics.fetch_ms!=null ? `fetch ${lastMetrics.fetch_ms}ms` : null,
                lastMetrics.extract_ms!=null ? `extract ${lastMetrics.extract_ms}ms` : null,
                lastMetrics.summarize_ms!=null ? `summarize ${lastMetrics.summarize_ms}ms` : null,
                lastMetrics.model ? `model: ${lastMetrics.model}` : null
              ].filter(Boolean).join(" • ")}
            </div>
          )}

          <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
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
            <button
              onClick={() => {
                fetch(`${API_URL}/feedback`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    mode,
                    liked: true,
                    len_preset: lengthMode === "presets" ? PRESETS[preset].label : "custom",
                    url: mode === "url" ? url : undefined,
                  }),
                });
              }}
              style={btn(true)}
            >
              👍
            </button>
            <button
              onClick={() => {
                fetch(`${API_URL}/feedback`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    mode,
                    liked: false,
                    len_preset: lengthMode === "presets" ? PRESETS[preset].label : "custom",
                    url: mode === "url" ? url : undefined,
                  }),
                });
              }}
              style={btn(true)}
            >
              👎
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
