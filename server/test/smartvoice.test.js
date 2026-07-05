import { afterEach, describe, expect, it, vi } from "vitest";
import { transcribe } from "../src/vnpt/smartvoice.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("SmartVoice STT error mapping", () => {
  it.each([401, 403])("maps upstream %s to STT_NO_PERMISSION", async (status) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ message: "No permission" }),
      { status },
    ));

    await expect(transcribe(Buffer.from("wav"))).rejects.toMatchObject({
      code: "STT_NO_PERMISSION",
      statusCode: 503,
      upstreamStatus: status,
      message: "Dịch vụ nhận dạng giọng nói chưa được cấp quyền",
    });
  });

  it("maps other upstream errors to a 502 service error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ message: "gateway failure" }),
      { status: 500 },
    ));

    await expect(transcribe(Buffer.from("wav"))).rejects.toMatchObject({
      code: "STT_UPSTREAM_ERROR",
      statusCode: 502,
      upstreamStatus: 500,
    });
  });

  it("maps an aborted request to STT_TIMEOUT", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation((url, { signal }) => (
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })
    ));

    const pending = transcribe(Buffer.from("wav"));
    const assertion = expect(pending).rejects.toMatchObject({
      code: "STT_TIMEOUT",
      statusCode: 503,
    });
    await vi.advanceTimersByTimeAsync(30000);
    await assertion;
  });
});
