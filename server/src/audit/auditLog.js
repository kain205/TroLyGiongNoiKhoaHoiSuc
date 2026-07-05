// Best-effort append-only audit log for the active Node chat path.
import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { AUDIT_LOG_DIR, AUDIT_TRACE_MAX_KB } from "../config.js";

export async function writeAuditLog(record, {
  logDir = AUDIT_LOG_DIR,
  traceMaxKb = AUDIT_TRACE_MAX_KB,
} = {}) {
  try {
    const ts = record.ts_start || new Date().toISOString();
    const day = /^\d{4}-\d{2}-\d{2}/.exec(ts)?.[0] || new Date().toISOString().slice(0, 10);
    const normalized = {
      request_id: record.request_id || null,
      ts_start: ts,
      ts_end: record.ts_end || new Date().toISOString(),
      pid: record.pid || null,
      doctor_id: record.doctor_id || "unknown",
      query: record.query || "",
      intent: record.intent || "unknown",
      query_intent: record.query_intent || "unknown",
      smartbot_intent: record.smartbot_intent || null,
      drugs: record.drugs || [],
      alerts: record.alerts || [],
      safety_status: record.safety_status || "unknown",
      safety_unverified: Boolean(record.safety_unverified),
      answer: record.answer || "",
      sources: record.sources || [],
      fallback: Boolean(record.fallback),
      latency_ms: Number(record.latency_ms) || 0,
      smartbot_trace: truncateUtf8(serializeTrace(record.smartbot_trace), traceMaxKb * 1024),
    };

    await mkdir(logDir, { recursive: true });
    await appendFile(resolve(logDir, `${day}.jsonl`), `${JSON.stringify(normalized)}\n`, "utf-8");
    return true;
  } catch (error) {
    console.error(`[audit log failed] ${error.message}`);
    return false;
  }
}

function serializeTrace(trace) {
  if (!trace) return "";
  if (typeof trace === "string") return trace;
  try {
    return JSON.stringify(trace);
  } catch {
    return "[unserializable SmartBot trace]";
  }
}

export function truncateUtf8(text, maxBytes) {
  const input = String(text || "");
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  const bytes = Buffer.from(input, "utf-8");
  if (bytes.length <= maxBytes) return input;
  const marker = Buffer.from("…", "utf-8");
  if (maxBytes <= marker.length) {
    return bytes.subarray(0, maxBytes).toString("utf-8").replace(/\uFFFD+$/g, "");
  }
  const prefix = bytes
    .subarray(0, maxBytes - marker.length)
    .toString("utf-8")
    .replace(/\uFFFD+$/g, "");
  return prefix + "…";
}
