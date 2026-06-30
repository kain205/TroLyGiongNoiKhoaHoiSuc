// VNPT SmartVoice client — STT + TTS (base https://api.idg.vnpt.vn).
// Docs: docs/smartvoice_docs/. Auth = Authorization Bearer + Token-id + Token-key.
import { STT, TTS, vnptHeaders } from "../config.js";

const STT_TIMEOUT_MS = 30000;
const TTS_TIMEOUT_MS = 30000;

// Speech-to-Text (sync). audioBuffer = WAV PCM 16bit mono (≤10MB, ~3–10s).
// POST multipart to /stt-service/v1/grpc/standard.
// Returns { text, confidence } — the first alternative of the first result.
//
// NOTE: we build the multipart body manually and send an explicit Content-Length.
// Node's fetch+FormData streams with `Transfer-Encoding: chunked`, which the VNPT
// gateway rejects mid-upload ("other side closed"); a fixed-length body fixes it.
export async function transcribe(audioBuffer, { filename = "audio.wav" } = {}) {
  const { body, boundary } = buildMultipart(
    { clientSession: `icu-${Date.now()}`, enableAutomaticPunctuation: "true" },
    { name: filename, data: audioBuffer },
  );

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), STT_TIMEOUT_MS);
  let resp;
  let raw;
  try {
    resp = await fetch(`${STT.baseUrl}/stt-service/v1/grpc/standard`, {
      method: "POST",
      headers: {
        ...vnptHeaders(STT),
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(body.length),
      },
      body,
      signal: ctrl.signal,
    });
    raw = await resp.text();
  } finally {
    clearTimeout(t);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }
  if (!resp.ok) {
    const detail = data?.error || data?.message || raw.slice(0, 200) || resp.statusText;
    throw new Error(`SmartVoice STT HTTP ${resp.status}: ${detail}`);
  }

  const results = data?.object?.results || [];
  const alt = results[0]?.alternatives?.[0];
  return {
    text: (alt?.transcript || "").trim(),
    confidence: alt?.confidence ?? null,
  };
}

// Assemble a multipart/form-data body as a single Buffer (for a fixed Content-Length).
function buildMultipart(fields, file) {
  const boundary = "----icuvnpt" + Date.now().toString(16);
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="audioFile"; filename="${file.name}"\r\n` +
        "Content-Type: audio/wav\r\n\r\n",
    ),
  );
  parts.push(Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), boundary };
}

// Text-to-Speech. POST JSON to /tts-service/v2/standard.
// Returns { audioLink, textId } — a hosted .wav URL (cached 24h on idg-obs.vnpt.vn).
export async function synthesize(text, opts = {}) {
  const body = {
    text,
    text_split: false,
    model: opts.model || TTS.model,
    region: opts.region || TTS.region,
    speed: String(opts.speed ?? TTS.speed),
    audio_format: "wav",
  };
  const data = await postJson(`${TTS.baseUrl}/tts-service/v2/standard`, body, TTS_TIMEOUT_MS);

  const obj = data?.object || {};
  const audioLink = obj.r_audio_full || obj.playlist?.[0]?.audio_link || null;
  if (obj.code && obj.code !== "success") {
    throw new Error(`SmartVoice TTS không thành công: code=${obj.code}`);
  }
  if (!audioLink) throw new Error("SmartVoice TTS không trả audio_link");
  return { audioLink, textId: obj.text_id || null };
}

async function postJson(url, body, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { ...vnptHeaders(TTS), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return await parseOrThrow(resp);
  } finally {
    clearTimeout(t);
  }
}

async function parseOrThrow(resp) {
  const raw = await resp.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }
  if (!resp.ok) {
    const detail = data?.message || data?.status || raw.slice(0, 200) || resp.statusText;
    throw new Error(`SmartVoice HTTP ${resp.status}: ${detail}`);
  }
  return data;
}
