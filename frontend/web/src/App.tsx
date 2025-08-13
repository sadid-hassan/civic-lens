import { useEffect, useState } from "react";

// Base URL for backend API
// Uses environment variable VITE_API_URL if available, otherwise defaults to localhost:8000
const API = import.meta.env.VITE_API_URL || "http://localhost:8000";


// --- Type Definitions ---
type ApiStatus = "checking" | "up" | "down";       // Possible states of backend connection
type HealthResponse = { ok: boolean };             // Shape of /health endpoint response
type SummarizeResponse = { summary: string };      // Shape of /summarize endpoint response



/**
 * 
 * @returns Main application component for CivicLens 
 * 
 * Handles: 
 * - Checking backend API health on page load
 * - Accepting user text input
 * - Sending text to backend for summarization
 * - Displaying results and error states
 */
export default function App() {
  // --- Component State ---
  const [apiStatus, setApiStatus] = useState<ApiStatus>("checking");  // Backend health status
  const [text, setText] = useState("");                               // Raw user input
  const [summary, setSummary] = useState("");                         // Summarized text from backend
  const [loading, setLoading] = useState(false);                      // Loading indicator for requests
  const [err, setErr] = useState("");                                 // Error message to show user

  /**
   * On first render (component mount):
   * - Calls /health endpoint to check if backend is reachable
   * - Updates 'apiStatus' accordingly
   */
  useEffect(() => {
    fetch(`${API}/health`)
      .then((r) => r.json() as Promise<HealthResponse>)
      .then((d) => setApiStatus(d.ok ? "up" : "down"))
      .catch(() => setApiStatus("down"));
  }, []); // Empty dependency array ensures this runs only once



  /**
   * @returns Sends the user's text to the backend summarization endpoint
   * - Shows a loading state while request is in flight
   * - Handles success (update 'summary') and errors (update 'err')
   */
  async function onSummarize() {
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
    } catch (error) {
      console.error(error);
      setErr("Failed to summarize. Is the backend running on :8000?");
    } finally {
      setLoading(false);
    }
  }



  // --- JSX UI ---
  return (
    <div style={{ maxWidth: 720, margin: "2rem auto", padding: "1rem" }}>
      <h1>CivicLens — WIP v2</h1>

      {apiStatus === "checking" && <div>⏳ Checking API…</div>}
      {apiStatus === "up" && <div style={{ color: "#22c55e" }}>✅ API healthy</div>}
      {apiStatus === "down" && (
        <div style={{ color: "#ef4444" }}>❌ API unreachable</div>
      )}

      <textarea
        style={{ width: "100%", height: 200 }}
        placeholder="Paste a couple paragraphs..."
        value={text}
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
          setText(e.target.value)
        }
      />

      <div style={{ marginTop: 12 }}>
        <button onClick={onSummarize} disabled={!text.trim() || loading}>
          {loading ? "Summarizing..." : "Summarize"}
        </button>
        {err && <span style={{ color: "red", marginLeft: 12 }}>{err}</span>}
      </div>

      {summary && (
        <div style={{ marginTop: 16, padding: 12, border: "1px solid #ccc" }}>
          <strong>Summary</strong>
          <p>{summary}</p>
        </div>
      )}
    </div>
  );
}
