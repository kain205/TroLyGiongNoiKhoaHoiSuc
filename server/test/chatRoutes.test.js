import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";

const botMocks = vi.hoisted(() => ({
  ask: vi.fn(),
  askStream: vi.fn(),
}));
const auditMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));

vi.mock("../src/vnpt/smartbot.js", () => ({
  ask: botMocks.ask,
  askStream: botMocks.askStream,
}));
vi.mock("../src/audit/auditLog.js", () => ({
  writeAuditLog: auditMock,
}));

import patientsRouter from "../src/routes/patients.js";

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", patientsRouter);
  app.use((error, req, res, next) => {
    res.status(500).json({ detail: error.message });
  });
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

afterEach(() => {
  botMocks.ask.mockReset();
  botMocks.askStream.mockReset();
  auditMock.mockClear();
});

async function post(path, query, headers = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ query }),
  });
}

function parseEvents(raw) {
  return raw.trim().split(/\n\n/).map((block) => {
    const event = /^event:\s*(.+)$/m.exec(block)?.[1];
    const data = /^data:\s*(.+)$/m.exec(block)?.[1];
    return { event, data: JSON.parse(data) };
  });
}

describe("chat safety orchestration", () => {
  it("returns a safety fallback with HTTP 200 when SmartBot fails", async () => {
    botMocks.ask.mockRejectedValue(Object.assign(new Error("bot offline"), { rawTrace: "partial" }));
    const response = await post("/api/patients/pt-001/chat", "Tiêu chuẩn ARDS theo Berlin", {
      "x-doctor-id": "doctor-9",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      alerts: [],
      fallback: true,
      fallback_reason: "smartbot_error",
      safety_status: "ok",
    });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      doctor_id: "doctor-9",
      fallback: true,
      smartbot_trace: "partial",
    }));
  });

  it("prepends an unverified banner for a fuzzy-only drug mention in caveat mode", async () => {
    botMocks.ask.mockResolvedValue({
      answer: "Thông tin guideline.",
      sources: [],
      rawTrace: "{}",
      transferToAgent: false,
    });
    const response = await post("/api/patients/pt-001/chat", "liều vancomy sin bao nhiêu?");
    const body = await response.json();

    expect(body.safety_status).toBe("unknown_drug");
    expect(body.safety_unverified).toBe(true);
    expect(body.unknown_drugs).toEqual(["vancomy sin"]);
    expect(body.answer).toMatch(/^⚠️ CHƯA XÁC MINH ĐƯỢC AN TOÀN THUỐC/);
    expect(botMocks.ask).toHaveBeenCalledOnce();
  });

  it("uses deterministic missing-data fallback without calling SmartBot", async () => {
    const response = await post("/api/patients/pt-012/chat", "liều vancomy sin bao nhiêu?");
    const body = await response.json();

    expect(body).toMatchObject({
      fallback: true,
      fallback_reason: "missing_required_fields",
      missing_fields: ["eGFR"],
    });
    expect(body.answer).toContain("Thiếu eGFR");
    expect(botMocks.ask).not.toHaveBeenCalled();
  });

  it("keeps SSE meta -> delta -> done and converts a stream error into done", async () => {
    botMocks.askStream.mockImplementation(() => (async function* stream() {
      yield { answer: "partial" };
      throw Object.assign(new Error("stream failed"), { rawTrace: "partial raw" });
    })());

    const response = await post("/api/patients/pt-001/chat/stream", "Tiêu chuẩn ARDS theo Berlin");
    const events = parseEvents(await response.text());

    expect(events.map((event) => event.event)).toEqual(["meta", "delta", "done"]);
    expect(events[0].data.alerts).toEqual([]);
    expect(events.at(-1).data).toMatchObject({
      fallback: true,
      fallback_reason: "smartbot_error",
      alerts: [],
    });
    expect(events.at(-1).data.answer).not.toContain("partial");
  });

  it("handles greeting and out-of-scope queries without calling SmartBot", async () => {
    const greeting = await (await post("/api/patients/pt-001/chat", "Hi")).json();
    expect(greeting).toMatchObject({
      intent: "greeting",
      fallback: false,
      fallback_reason: null,
      cited_sources: [],
      smartbot_intent: null,
    });

    const blocked = await (await post(
      "/api/patients/pt-001/chat",
      "Phác đồ dùng thuốc vận mạch trong sốc tim",
    )).json();
    expect(blocked).toMatchObject({
      intent: "out_of_scope",
      fallback: true,
      fallback_reason: "out_of_scope",
      cited_sources: [],
    });
    expect(botMocks.ask).not.toHaveBeenCalled();
  });

  it("returns empty_answer without calling SmartBot for unsupported exact vancomycin dosing", async () => {
    const query = "Bệnh nhân creatinine tăng cao thì liều vancomycin cần giảm bao nhiêu";
    const body = await (await post("/api/patients/pt-001/chat", query)).json();
    expect(body).toMatchObject({
      intent: "aki_lieu",
      fallback: true,
      fallback_reason: "empty_answer",
      cited_sources: [],
    });
    expect(body.answer).toContain("Không đủ thông tin trong guideline");
    expect(botMocks.ask).not.toHaveBeenCalled();
  });

  it("rejects a SmartBot intent mismatch and strips its sources", async () => {
    botMocks.ask.mockResolvedValue({
      answer: "Nội dung ARDS.",
      sources: [{
        n: 1,
        source: "icu_2015.docx",
        title: "ICU 2015",
        pages: ["22"],
        verified: true,
      }],
      smartbotIntent: "aki_lieu",
      rawTrace: "{}",
      transferToAgent: false,
    });
    const body = await (await post(
      "/api/patients/pt-001/chat",
      "Bệnh nhân suy hô hấp cấp giảm oxy máu nặng thì chẩn đoán dựa vào gì",
    )).json();
    expect(body).toMatchObject({
      intent: "ards",
      smartbot_intent: "aki_lieu",
      fallback: true,
      fallback_reason: "intent_mismatch",
      cited_sources: [],
    });
  });

  it("rejects a clinical answer with no verified sources", async () => {
    botMocks.ask.mockResolvedValue({
      answer: "MAP mục tiêu 65 mmHg.",
      sources: [],
      smartbotIntent: "sepsis_ssc",
      rawTrace: "{}",
      transferToAgent: false,
    });
    const body = await (await post(
      "/api/patients/pt-001/chat",
      "Mục tiêu MAP trong sốc nhiễm khuẩn theo SSC là bao nhiêu",
    )).json();
    expect(body).toMatchObject({
      intent: "sepsis_ssc",
      fallback: true,
      fallback_reason: "empty_answer",
      cited_sources: [],
    });
  });

  it("normalizes an explicit SmartBot evidence refusal to empty_answer", async () => {
    botMocks.ask.mockResolvedValue({
      answer: "Tài liệu không cung cấp con số cụ thể nên tôi không thể đưa ra con số.",
      sources: [{
        n: 1,
        source: "icu_2015.docx",
        title: "ICU 2015",
        pages: ["84"],
        verified: true,
      }],
      smartbotIntent: "aki_lieu",
      rawTrace: "{}",
      transferToAgent: false,
    });
    const body = await (await post(
      "/api/patients/pt-001/chat",
      "Kháng sinh ở người suy thận cấp nên theo dõi thế nào",
    )).json();
    expect(body).toMatchObject({
      intent: "aki_lieu",
      fallback: true,
      fallback_reason: "empty_answer",
      cited_sources: [],
    });
  });

  it("keeps a verified matching clinical answer", async () => {
    botMocks.ask.mockResolvedValue({
      answer: "MAP mục tiêu 65 mmHg.",
      sources: [{
        n: 1,
        source: "ssc_2021.docx",
        title: "Surviving Sepsis Campaign 2021",
        pages: ["188"],
        verified: true,
      }],
      smartbotIntent: "sepsis_ssc",
      rawTrace: "{}",
      transferToAgent: false,
    });
    const body = await (await post(
      "/api/patients/pt-001/chat",
      "Mục tiêu MAP trong sốc nhiễm khuẩn theo SSC là bao nhiêu",
    )).json();
    expect(body).toMatchObject({
      intent: "sepsis_ssc",
      smartbot_intent: "sepsis_ssc",
      fallback: false,
      cited_sources: [expect.objectContaining({ verified: true })],
    });
  });

  it("returns the same deterministic empty_answer over SSE without deltas", async () => {
    const response = await post(
      "/api/patients/pt-001/chat/stream",
      "Bệnh nhân creatinine tăng cao thì liều vancomycin cần giảm bao nhiêu",
    );
    const events = parseEvents(await response.text());
    expect(events.map((event) => event.event)).toEqual(["meta", "done"]);
    expect(events.at(-1).data).toMatchObject({
      intent: "aki_lieu",
      fallback: true,
      fallback_reason: "empty_answer",
      cited_sources: [],
    });
    expect(botMocks.askStream).not.toHaveBeenCalled();
  });
});
