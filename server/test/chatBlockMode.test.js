import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";

vi.hoisted(() => {
  process.env.SAFETY_FAIL_MODE = "block";
});
const botMock = vi.hoisted(() => vi.fn());

vi.mock("../src/vnpt/smartbot.js", () => ({
  ask: botMock,
  askStream: vi.fn(),
}));
vi.mock("../src/audit/auditLog.js", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(true),
}));

import patientsRouter from "../src/routes/patients.js";

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", patientsRouter);
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => {
  delete process.env.SAFETY_FAIL_MODE;
  return new Promise((resolve) => server.close(resolve));
});

describe("SAFETY_FAIL_MODE=block", () => {
  it("does not call SmartBot for an unverified medicine query", async () => {
    const response = await fetch(`${base}/api/patients/pt-001/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "liều vancomy sin bao nhiêu?" }),
    });
    const body = await response.json();

    expect(body).toMatchObject({
      fallback: true,
      fallback_reason: "safety_unverified_block",
      safety_unverified: true,
    });
    expect(body.answer).toContain("Không cung cấp nội dung tư vấn thuốc");
    expect(botMock).not.toHaveBeenCalled();
  });
});
