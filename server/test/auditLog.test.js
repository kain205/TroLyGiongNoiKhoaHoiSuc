import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncateUtf8, writeAuditLog } from "../src/audit/auditLog.js";

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("structured audit log", () => {
  it("writes one normalized JSONL record per request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "icu-audit-"));
    tempDirs.push(dir);
    const ok = await writeAuditLog({
      request_id: "req-1",
      ts_start: "2026-07-05T01:02:03.000Z",
      ts_end: "2026-07-05T01:02:04.000Z",
      pid: "pt-001",
      doctor_id: "doctor-7",
      query: "test",
      intent: "ards",
      query_intent: "general",
      smartbot_intent: "ards",
      drugs: [],
      alerts: [],
      safety_status: "ok",
      safety_unverified: false,
      answer: "answer",
      sources: [],
      fallback: false,
      latency_ms: 1000,
      smartbot_trace: "raw",
    }, { logDir: dir, traceMaxKb: 1 });

    expect(ok).toBe(true);
    const line = await readFile(join(dir, "2026-07-05.jsonl"), "utf-8");
    const record = JSON.parse(line.trim());
    expect(record).toMatchObject({
      request_id: "req-1",
      doctor_id: "doctor-7",
      intent: "ards",
      query_intent: "general",
      smartbot_intent: "ards",
      safety_status: "ok",
      smartbot_trace: "raw",
    });
  });

  it("truncates raw traces by UTF-8 byte size without a replacement character", () => {
    const result = truncateUtf8("á".repeat(20), 9);
    expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(9);
    expect(result).not.toContain("\uFFFD");
    expect(result.endsWith("…")).toBe(true);
  });
});
