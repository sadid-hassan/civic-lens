import { useEffect, useState } from "react";

// Base URL for backend API
// Uses environment variable VITE_API_URL if available, otherwise defaults to localhost:8000
const API = import.meta.env.VITE_API_URL || "http://localhost:8000";

// --- Type Definitions ---
type ApiStatus = "checking" | "up" | "down";     // Possible states of backend connection
type HealthResponse = { ok: boolean };           // Shape of /health endpoint response
type SummarizeResponse = { summary: string };    // Shape of /summarize and /summarize-url responses

/**
 * Utility: Convert unknown error objects into user-friendly strings
 */
function humanizeError(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  try {
    const raw = String((e as { message?: string })?.message ?? e ?? "");
    if (!raw) return "Something went wrong.";
    const parsed = JSON.parse(raw) as { detail?: string | { message?: string } };
    if (typeof parsed.detail === "string") return parsed.detail;
    if (typeof parsed.detail?.message === "string") return parsed.detail.message;
    return raw;
  } catch {
    return "Something went wrong. Please try again.";
  }
}

/**
 * Main application component for CivicLens
 */
export default function App() {
  // UI mode: summarize pasted text OR a URL
  const [mode, setMode] = useState<"text" | "url">("text");

  // Common state
  const [apiStatus, setApiStatus] = useState<ApiStatus>("checking");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  // Text mode state
  const [text, setText] = useState("");
  const [summary, setSummary] = useState("");

  // URL mode state
  const [url, setUrl] = useState("");

  // Check backend health once on load
  useEffect(() => {
    fetch(`${API}/health`)
      .then((r) => r.json() as Promise<HealthResponse>)
      .then((d) => setApiStatus(d.ok ? "up" : "down"))
      .catch(() => setApiStatus("down"));
  }, []);

  // --- API Calls ---

  async function onSummarizeText() {
    setLoading(true);
    setErr("");
    setSummary("");
    try {
      const res = await fetch(`${API}/summarize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, max_len: 180, min_len: 60 }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as SummarizeResponse;
      setSummary(data.summary);
    } catch (e) {
      setErr(humanizeError(e));
    } finally {
      setLoading(false);
    }
  }

  async function onSummarizeUrl() {
    setLoading(true);
    setErr("");
    setSummary("");
    try {
      const res = await fetch(`${API}/summarize-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as SummarizeResponse;
      
      setSummary(data.summary);
    } catch (e) {
      setErr(humanizeError(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: "2rem auto", padding: "1rem" }}>
      <h1>CivicLens — WIP v2</h1>

      {/* API status */}
      {apiStatus === "checking" && <div>⏳ Checking API…</div>}
      {apiStatus === "up" && <div style={{ color: "#22c55e" }}>✅ API healthy</div>}
      {apiStatus === "down" && <div style={{ color: "#ef4444" }}>❌ API unreachable</div>}

      {/* Mode switch */}
      <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
        <label>
          <input
            type="radio"
            name="mode"
            value="text"
            checked={mode === "text"}
            onChange={() => setMode("text")}
          />{" "}
          Summarize Text
        </label>
        <label>
          <input
            type="radio"
            name="mode"
            value="url"
            checked={mode === "url"}
            onChange={() => setMode("url")}
          />{" "}
          Summarize URL
        </label>
      </div>

      {/* Input */}
      <div style={{ marginTop: 12 }}>
        {mode === "text" ? (
          <textarea
            style={{ width: "100%", height: 200 }}
            placeholder="Paste a couple paragraphs..."
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        ) : (
          <input
            style={{ width: "100%", height: 40, padding: "0 8px" }}
            placeholder="https://example.com/my-article"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        )}
      </div>

      {/* Actions + Errors */}
      <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 12 }}>
        {mode === "text" ? (
          <button onClick={onSummarizeText} disabled={!text.trim() || loading}>
            {loading ? "Summarizing..." : "Summarize"}
          </button>
        ) : (
          <button onClick={onSummarizeUrl} disabled={!url.trim() || loading}>
            {loading ? "Summarizing..." : "Summarize URL"}
          </button>
        )}
        {err && <span style={{ color: "salmon" }}>{err}</span>}
      </div>

      {/* Output */}
      {summary && (
        <div style={{ marginTop: 16, padding: 12, border: "1px solid #ccc" }}>
          <strong>Summary</strong>
          <p>{summary}</p>
        </div>
      )}
    </div>
  );
}
