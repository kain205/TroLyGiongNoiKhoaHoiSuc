import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  findMissingRequiredFields,
} from "../src/rag/contextBuilder.js";

const observation = (value) => ({ value });

describe("deterministic required fields", () => {
  it("requires eGFR for dosing", () => {
    expect(findMissingRequiredFields("dosing", {}, { egfr: { egfr: null } })).toEqual(["eGFR"]);
    expect(findMissingRequiredFields("dosing", {}, { egfr: { egfr: 42 } })).toEqual([]);
  });

  it("treats empty medication and condition lists as missing for contraindication", () => {
    expect(findMissingRequiredFields("contraindication", {
      medications: [],
      conditions: [],
    }, {})).toEqual(["danh sách thuốc đang dùng", "bệnh nền"]);
  });

  it("checks only the requested score fields", () => {
    const ctx = {
      observations: {
        systolic_bp: observation(100),
        diastolic_bp: observation(null),
      },
    };
    expect(findMissingRequiredFields("scoring", ctx, {}, ["map"]))
      .toEqual(["huyết áp tâm trương"]);
    expect(findMissingRequiredFields("scoring", ctx, {}, []))
      .toEqual([]);
  });

  it("adds a hard prompt boundary when safety is unverified", () => {
    const prompt = buildSystemPrompt("patient", "", "dosing", { unverified: true });
    expect(prompt).toContain("AN TOÀN THUỐC CHƯA XÁC MINH");
    expect(prompt).toContain("Không được nói hoặc ngụ ý rằng thuốc đã được kiểm tra an toàn");
  });

  it("pins a clinical intent to its approved documents and insufficiency sentinel", () => {
    const prompt = buildSystemPrompt("patient", "", "general", {
      domainIntent: "sepsis_ssc",
    });
    expect(prompt).toContain("Intent: sepsis_ssc");
    expect(prompt).toContain("Surviving Sepsis Campaign 2021");
    expect(prompt).toContain("__INSUFFICIENT_GUIDELINE__");
    expect(prompt).not.toContain("Thông tư 51/2017/TT-BYT về phản vệ");
  });
});
