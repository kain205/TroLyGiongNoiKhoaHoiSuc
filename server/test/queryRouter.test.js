import { describe, expect, it } from "vitest";
import { routeQuery } from "../src/rag/queryRouter.js";
import { DRUG_LEXICON } from "../src/asr/drugLexicon.js";

describe("query router drug safety boundary", () => {
  const clinicalCases = [
    ["Mục tiêu MAP trong sốc nhiễm khuẩn theo SSC là bao nhiêu", "sepsis_ssc"],
    ["Huyết áp trung bình bao nhiêu thì đạt trong bệnh nhân nhiễm trùng huyết nặng", "sepsis_ssc"],
    ["Quy trình chống sốc phản vệ", "phan_ve"],
    ["Tiêm adrenaline liều bao nhiêu khi bệnh nhân bị dị ứng nặng tụt huyết áp", "phan_ve"],
    ["Tiêu chuẩn chẩn đoán ARDS theo Berlin", "ards"],
    ["Bệnh nhân suy hô hấp cấp giảm oxy máu nặng thì chẩn đoán dựa vào gì", "ards"],
    ["Chỉnh liều kháng sinh khi suy thận cấp", "aki_lieu"],
    ["Bệnh nhân creatinine tăng cao thì liều vancomycin cần giảm bao nhiêu", "aki_lieu"],
  ];

  it.each(clinicalCases)("routes %s to %s", (query, expected) => {
    expect(routeQuery(query).domainIntent).toBe(expected);
  });

  it("separates a sepsis MAP guideline question from patient scoring", () => {
    const route = routeQuery("Mục tiêu MAP trong sốc nhiễm khuẩn theo SSC là bao nhiêu");
    expect(route.intent).toBe("general");
    expect(route.scoreTargets).toEqual([]);
  });

  it("blocks unsupported clinical scope and recognizes a standalone greeting", () => {
    expect(routeQuery("Phác đồ dùng thuốc vận mạch trong sốc tim").domainIntent)
      .toBe("out_of_scope");
    expect(routeQuery("Liều dobutamine trong sốc tim là bao nhiêu").domainIntent)
      .toBe("out_of_scope");
    expect(routeQuery("Hi").domainIntent).toBe("greeting");
  });

  it("marks an exact vancomycin reduction request as unsupported evidence", () => {
    expect(routeQuery("Bệnh nhân creatinine tăng cao thì liều vancomycin cần giảm bao nhiêu"))
      .toMatchObject({
        domainIntent: "aki_lieu",
        requiresExactDoseEvidence: true,
      });
  });

  it("returns exact lexicon drugs for deterministic safety", () => {
    const result = routeQuery("Có dùng Vancomycin và Warfarin được không?");
    expect(result.drugs).toEqual(expect.arrayContaining(["Vancomycin", "Warfarin"]));
    expect(result.unknownDrugs).toEqual([]);
  });

  it("flags a likely garble but never promotes it to an exact drug", () => {
    const result = routeQuery("liều vancomy sin bao nhiêu?");
    expect(result.drugs).toEqual([]);
    expect(result.unknownDrugs).toEqual(["vancomy sin"]);
  });

  it("does not flag benign clinical text", () => {
    expect(routeQuery("bệnh nhân ổn định, tiếp tục theo dõi").unknownDrugs).toEqual([]);
  });

  it("uses the ASR canonical lexicon for chat exact matching", () => {
    for (const drug of DRUG_LEXICON) {
      expect(routeQuery(`đánh giá ${drug}`).drugs).toContain(drug);
    }
  });

  it("detects a specific scoring target without confusing qSOFA and SOFA", () => {
    expect(routeQuery("qSOFA hiện tại").scoreTargets).toEqual(["qsofa"]);
    expect(routeQuery("SOFA hiện tại").scoreTargets).toEqual(["sofa"]);
    expect(routeQuery("điểm hiện tại").scoreTargets).toEqual([]);
  });
});
