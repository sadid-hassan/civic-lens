import React, { useEffect, useState } from "react";

// Base URL for backend API (uses VITE_API_URL if set, otherwise localhost:8000)
const API = import.meta.env.VITE_API_URL || "http://localhost:8000";

// --- Type Definitions ---
type ApiStatus = "checking" | "up" | "down";      // Backend connection states
type HealthResponse = { ok: boolean };            // Shape of /health response
type SummarizeResponse = { summary: string };     // Shape of summarization response

/**
 * CivicLens App
 *
 * Responsibilities:
 * - Check backend API health on mount
 * - Allow user to summarize either pasted text or a URL
 * - Handle loading + error states gracefully
 * - Display summary results
 */
export default function App() {
  // UI mode: user chooses between text summarization or URL summarization
  const [mode, setMode] = useState<"text" | "url">("text");

  // Shared state
  const [apiStatus, setApiStatus] = useState<ApiStatus>("checking");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  // Text mode state
  const [text, setText] = useState("");
  const [summary, setSummary] = useState("");

  // URL mode state
  const [url, setUrl] = useState("");

  // --- Effects ---
  // Runs once on mount to check if backend is reachable
  useEffect(() => {
    fetch(`${API}/health`)
      .then((r) => r.json() as Promise<HealthResponse>)
      .then((d) => setApiStatus(d.ok ? "up" : "down"))
      .catch(() => setApiStatus("down"));
  }, []);

  // --- Actions ---
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
      console.error(e);
      setErr("Failed to summarize text. Is the backend running on :8000?");
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
      console.error(e);
      // NOTE: Some URLs may fail if content cannot be extracted (e.g., paywalls)
      setErr("Failed to summarize URL. Try a different article or check backend logs.");
    } finally {
      setLoading(false);
    }
  }

  // --- UI ---
  return (
    <div style={{ maxWidth: 720, margin: "2rem auto", padding: "1rem" }}>
      <h1>CivicLens — WIP v2</h1>

      {/* API health indicator */}
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

      {/* Input field */}
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
