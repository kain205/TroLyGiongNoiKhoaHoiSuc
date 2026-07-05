// Production is served by the Express app, so API calls stay on the current
// origin. Local Vite development still targets the backend on port 8000.
const BASE =
  import.meta.env.VITE_API_BASE ??
  (import.meta.env.DEV ? "http://localhost:8000" : "");

async function json(res) {
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch { /* ignore */ }
    throw new Error(`${res.status}: ${detail}`);
  }
  return res.json();
}

export const listPatients = () => fetch(`${BASE}/api/patients`).then(json);

export const getProfile = (pid) =>
  fetch(`${BASE}/api/patients/${pid}`).then(json);

// The opening assessment runs the full RAG pipeline (~tens of seconds cold). React StrictMode
// double-invokes effects in dev, and re-mounts re-fire them — so we dedupe per patient: concurrent
// callers share ONE in-flight request, and a settled result is cached. This stops two heavy
// pipeline runs from racing on a single-GPU backend (which was wedging it → "Failed to fetch").
const _assessment = new Map(); // pid -> Promise
export const getAssessment = (pid) => {
  if (!_assessment.has(pid)) {
    const p = fetch(`${BASE}/api/patients/${pid}/assessment`, { method: "POST" })
      .then(json)
      .catch((e) => { _assessment.delete(pid); throw e; }); // let a failed run be retried
    _assessment.set(pid, p);
  }
  return _assessment.get(pid);
};

export const sendChat = (pid, query) =>
  fetch(`${BASE}/api/patients/${pid}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  }).then(json);

// Streaming chat (SSE over fetch). Calls onMeta (safety alerts, immediate),
// onDelta ({answer} growing), onDone (final payload), onError. The answer appears
// progressively so an ICU clinician sees the response forming in real time.
export async function sendChatStream(pid, query, { onMeta, onDelta, onDone, onError } = {}) {
  const res = await fetch(`${BASE}/api/patients/${pid}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok || !res.body) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch { /* ignore */ }
    throw new Error(`${res.status}: ${detail}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      let data = "";
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      if (event === "meta") onMeta?.(parsed);
      else if (event === "delta") onDelta?.(parsed);
      else if (event === "done") onDone?.(parsed);
      else if (event === "error") onError?.(parsed);
    }
  }
}

// Push-to-talk: POST the raw WAV blob, get back {text, latency_s, suggestions}. The UI puts
// `text` into the editable composer — it is never auto-sent.
export const transcribeAudio = (blob) =>
  fetch(`${BASE}/api/asr/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: blob,
  }).then(json);

// Text-to-speech: send an answer, get back { audio_url } (a hosted .wav, cached 24h
// on VNPT). The UI plays it directly via an <audio> element.
export const synthesizeSpeech = (text) =>
  fetch(`${BASE}/api/tts/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  }).then(json);
