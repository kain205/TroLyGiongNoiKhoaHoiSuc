import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getContraindicationText,
  getInteractionText,
} from "../src/safety/openfda.js";

const runId = `${process.pid}-${Date.now()}`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const okJson = (data) => ({
  ok: true,
  status: 200,
  json: async () => data,
});

describe("OpenFDA cache safety", () => {
  it("does not negative-cache transport failures", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    const drug = `CacheFailureDrugA-${runId}`;
    await expect(getInteractionText(drug)).rejects.toThrow("OpenFDA lookup failed");
    await expect(getInteractionText(drug)).rejects.toThrow("OpenFDA lookup failed");
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("caches a valid empty HTTP 200 result", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okJson({ results: [] }));

    const drug = `CacheEmptyDrugB-${runId}`;
    await expect(getContraindicationText(drug)).resolves.toEqual([]);
    await expect(getContraindicationText(drug)).resolves.toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("caches successful sections and refreshes them after TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okJson({
      results: [{ contraindications: ["Avoid in condition X."] }],
    }));

    const drug = `CacheTtlDrugC-${runId}`;
    await expect(getContraindicationText(drug))
      .resolves.toEqual(["Avoid in condition X."]);
    await getContraindicationText(drug);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-01-02T01:00:00Z"));
    await getContraindicationText(drug);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
