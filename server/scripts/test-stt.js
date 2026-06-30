// Diagnostic: call SmartVoice STT with the VNPT sample WAV. Builds multipart MANUALLY
// with an explicit Content-Length (avoids chunked transfer-encoding, which the VNPT
// gateway may reject -> "other side closed"). Does NOT print the token.
// Run: node scripts/test-stt.js
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { STT as SV } from "../src/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(__dirname, "..", "..", "docs", "smartvoice_docs", "Sample test", "Speech to Text", "eLabs-1.wav");

const audio = readFileSync(SAMPLE);
console.log(`sample WAV: ${audio.length} bytes; access startsWith Bearer: ${SV.accessToken.startsWith("Bearer ")}`);

const URL = `${SV.baseUrl}/stt-service/v1/grpc/standard`;
const bearer = SV.accessToken.startsWith("Bearer ") ? SV.accessToken : `Bearer ${SV.accessToken}`;
const rawTok = SV.accessToken.replace(/^Bearer\s+/, "");

// Manually assemble a multipart/form-data body as a single Buffer.
function buildMultipart(fields, file) {
  const boundary = "----icudiag" + Date.now().toString(16);
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="audioFile"; filename="${file.name}"\r\n` +
        `Content-Type: audio/wav\r\n\r\n`,
    ),
  );
  parts.push(file.data);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), boundary };
}

async function tryReq(name, auth, extraHeaders = {}) {
  const { body, boundary } = buildMultipart(
    { clientSession: `diag-${Date.now()}` },
    { name: "eLabs-1.wav", data: audio },
  );
  try {
    const resp = await fetch(URL, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Token-id": SV.tokenId,
        "Token-key": SV.tokenKey,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(body.length),
        ...extraHeaders,
      },
      body,
      duplex: "half",
    });
    const text = await resp.text();
    console.log(`\n[${name}] HTTP ${resp.status}\n  ${text.slice(0, 400)}`);
  } catch (e) {
    console.log(`\n[${name}] ERROR ${e.message}${e.cause ? " | cause: " + (e.cause.code || e.cause.message) : ""}`);
  }
}

await tryReq("A: Bearer, manual multipart + Content-Length", bearer);
await tryReq("B: raw token, manual multipart + Content-Length", rawTok);
