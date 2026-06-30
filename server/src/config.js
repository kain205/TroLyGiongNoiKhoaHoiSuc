// Central config — env + resolved paths. Single source of truth (port of src/paths.py).
import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// server/src -> repo root is two levels up.
export const ROOT = resolve(__dirname, "..", "..");
export const DATA_DIR = resolve(ROOT, "data");
export const MOCK_DIR = resolve(DATA_DIR, "mock");

export const PORT = Number(process.env.PORT) || 8000;
export const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";

// VNPT SmartVoice — base api.idg.vnpt.vn. STT and TTS are SEPARATE APIs with
// SEPARATE token sets; each falls back to the shared SV_* vars if not set.
const SV_BASE = (process.env.SV_BASE_URL || "https://api.idg.vnpt.vn").replace(/\/+$/, "");
const shared = {
  accessToken: process.env.SV_ACCESS_TOKEN || "",
  tokenId: process.env.SV_TOKEN_ID || "",
  tokenKey: process.env.SV_TOKEN_KEY || "",
};

export const STT = {
  baseUrl: SV_BASE,
  accessToken: process.env.STT_ACCESS_TOKEN || shared.accessToken,
  tokenId: process.env.STT_TOKEN_ID || shared.tokenId,
  tokenKey: process.env.STT_TOKEN_KEY || shared.tokenKey,
};

export const TTS = {
  baseUrl: SV_BASE,
  accessToken: process.env.TTS_ACCESS_TOKEN || shared.accessToken,
  tokenId: process.env.TTS_TOKEN_ID || shared.tokenId,
  tokenKey: process.env.TTS_TOKEN_KEY || shared.tokenKey,
  region: process.env.TTS_REGION || "female_north",
  model: process.env.TTS_MODEL || "news",
  speed: process.env.TTS_SPEED || "1",
};

// VNPT SmartBot (LLM/RAG) — base assistant-stream.vnpt.vn (different domain!)
export const SB = {
  url: process.env.SB_URL || "https://assistant-stream.vnpt.vn/v1/conversation",
  botId: process.env.SB_BOT_ID || "",
  accessToken: process.env.SB_ACCESS_TOKEN || "",
  tokenId: process.env.SB_TOKEN_ID || "",
  tokenKey: process.env.SB_TOKEN_KEY || "",
};

export const OPENFDA_API_KEY = process.env.OPENFDA_API_KEY || "";

// Auth headers shared by every VNPT call. `accessToken` is stored WITHOUT the
// "Bearer " prefix in .env; we add it here so callers never have to.
export function vnptHeaders({ accessToken, tokenId, tokenKey }) {
  return {
    Authorization: accessToken.startsWith("Bearer ") ? accessToken : `Bearer ${accessToken}`,
    "Token-id": tokenId,
    "Token-key": tokenKey,
  };
}
