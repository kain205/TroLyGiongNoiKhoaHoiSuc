// Allergy cross-reactivity + drug suggestion ports (offline, no network).
import { describe, it, expect, vi, afterEach } from "vitest";
import { checkAllergies, runSafetyScan } from "../src/safety/safety.js";
import { suggestDrugs } from "../src/asr/drugMatch.js";

afterEach(() => vi.restoreAllMocks());

describe("checkAllergies", () => {
  const ctx = {
    allergies: [{ allergen: "Penicillin", criticality: "high", reaction: "anaphylaxis" }],
  };

  it("flags a direct allergen match", () => {
    const alerts = checkAllergies(["Penicillin"], ctx);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].match).toBe("direct");
  });

  it("flags a cross-reactive drug (Amoxicillin vs Penicillin allergy)", () => {
    const alerts = checkAllergies(["Amoxicillin"], ctx);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].match).toContain("cross-reactivity");
  });

  it("does not flag an unrelated drug", () => {
    expect(checkAllergies(["Propofol"], ctx)).toHaveLength(0);
  });

  it("returns [] when there are no allergies", () => {
    expect(checkAllergies(["Penicillin"], { allergies: [] })).toHaveLength(0);
  });
});

describe("suggestDrugs (suggest-only fuzzy recovery)", () => {
  it("recovers a split garble 'vancomy sin' -> Vancomycin", () => {
    const out = suggestDrugs("cho benh nhan vancomy sin");
    expect(out.some((s) => s.suggestion === "Vancomycin")).toBe(true);
  });

  // Suggest-only is fuzzy by design; benign text may yield a low-confidence chip
  // the doctor ignores. The contract is "no HIGH-confidence false drug", not zero.
  it("does not emit a high-confidence drug for benign clinical text", () => {
    const out = suggestDrugs("bệnh nhân ổn định");
    expect(out.every((s) => s.score < 85)).toBe(true);
  });
});

describe("runSafetyScan", () => {
  it("preserves allergy alerts when both OpenFDA checks fail", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const result = await runSafetyScan(["Amoxicillin"], {
      allergies: [{ allergen: "Penicillin", criticality: "high" }],
      conditions: [{ name_en: "Renal failure", name_vi: "Suy thận" }],
      medications: [{ name: "Warfarin" }],
    });

    expect(result.alerts.some((a) => a.type === "allergy")).toBe(true);
    expect(result.status).toBe("degraded");
    expect(result.failedChecks).toEqual(["contraindications", "interactions"]);
  });

  it("reports unknown drugs without scanning a guessed medicine", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await runSafetyScan([], {}, { unknownDrugs: ["vancomy sin"] });

    expect(result).toEqual({
      alerts: [],
      status: "unknown_drug",
      failedChecks: [],
      unknownDrugs: ["vancomy sin"],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
