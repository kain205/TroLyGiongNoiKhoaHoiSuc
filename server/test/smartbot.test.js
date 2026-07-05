import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ask,
  askStream,
  collectSourceCandidates,
  normalizeSources,
} from "../src/vnpt/smartbot.js";

afterEach(() => vi.restoreAllMocks());

function payload(text, status = 0, extra = {}) {
  return {
    message: "IDG-00000200",
    object: {
      sb: {
        card_data: [{ type: "text", play_type: "text", text, ...extra }],
        card_data_info: { status },
      },
    },
  };
}

describe("SmartBot response checkpoint", () => {
  it("sends the livechat chunk-stream payload exactly once", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(payload("Answer"))));

    await ask("query", "unused prompt", { sessionId: "session-1" });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const request = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(request).toEqual({
      bot_id: expect.any(String),
      session_id: "session-1",
      sender_id: "team.22@vnptai.io",
      input_channel: "livechat",
      stream: "1",
      user_auth_level: 2,
      tts_model: "news",
      tts_region: "female_north",
      metadata: {},
      settings: {
        enable_chunk_stream: 1,
        system_prompt: "unused prompt",
        advance_prompt: "null",
      },
      text: "query",
    });
    expect(request.settings.system_prompt).toBe("unused prompt");
  });

  it("keeps raw JSON/cards and returns verified intent-scoped sources", async () => {
    const body = payload("Guideline answer", 0, {
      references: [{ title: "ssc_2021.docx", page_id: 12 }],
    });
    body.object.sb.intent_name = "sepsis_ssc";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body)));

    const result = await ask("query", "prompt", { domainIntent: "sepsis_ssc" });
    expect(result.answer).toBe("Guideline answer");
    expect(result.cards[0].type).toBe("text");
    expect(result.rawTrace).toContain("Guideline answer");
    expect(result.sources[0]).toMatchObject({
      source: "ssc_2021.docx",
      title: "Surviving Sepsis Campaign 2021",
      pages: ["12"],
      verified: true,
    });
    expect(result.smartbotIntent).toBe("sepsis_ssc");
  });

  it("decodes the documented dataBase64 wrapper", async () => {
    const wrapped = {
      dataBase64: Buffer.from(JSON.stringify(payload("Decoded answer"))).toString("base64"),
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(wrapped)));

    await expect(ask("query", "prompt")).resolves.toMatchObject({
      answer: "Decoded answer",
    });
  });

  it("streams CRLF-delimited events and returns a terminal trace", async () => {
    const first = payload("Part", 1);
    const final = payload("Part complete", 2, {
      references: [{ title: "ssc_2021.docx", page_id: 8 }],
    });
    final.object.sb.intent_name = "sepsis_ssc";
    const sse = `data: ${JSON.stringify(first)}\r\n\r\ndata: ${JSON.stringify(final)}\r\n\r\n`;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(sse, {
      headers: { "Content-Type": "text/event-stream" },
    }));

    const chunks = [];
    for await (const chunk of askStream("query", "prompt", {
      domainIntent: "sepsis_ssc",
    })) chunks.push(chunk);

    expect(chunks.at(-1)).toMatchObject({
      answer: "Part complete",
      done: true,
    });
    expect(chunks.at(-1).rawTrace).toContain("data:");
    expect(chunks.at(-1).sources[0].source).toBe("ssc_2021.docx");
    expect(chunks.at(-1).smartbotIntent).toBe("sepsis_ssc");
  });

  it("replaces delta text with the clean final event instead of duplicating it", async () => {
    const delta1 = payload("MAP ≥ 65 mmHg.\\n\\n", 1);
    const delta2 = payload("Cụ thể...", 1);
    const final = payload("MAP ≥ 65 mmHg.\n\nCụ thể...", 2);
    const sse = [delta1, delta2, final]
      .map((event) => `data:${JSON.stringify(event)}\n\n`)
      .join("");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(sse, {
      headers: { "Content-Type": "text/event-stream" },
    }));

    const chunks = [];
    for await (const chunk of askStream("query", "prompt")) chunks.push(chunk);

    expect(chunks.at(-1).answer).toBe("MAP ≥ 65 mmHg.\n\nCụ thể...");
    expect(chunks.at(-1).answer).not.toContain("\\n");
    expect(chunks.at(-1).answer.match(/MAP ≥ 65 mmHg/g)).toHaveLength(1);
  });

  it("does not invent sources when official-style cards have none", () => {
    const documented = payload("Text card");
    documented.object.sb.card_data.push({
      type: "chuyen_gdv",
      play_type: "text",
      text: "",
      buttons: [],
      audio_url: "",
    });
    expect(collectSourceCandidates([documented])).toEqual([]);
  });

  it("groups duplicate page hits and drops documents outside the intent allowlist", () => {
    const final = payload("ARDS", 2, {
      references: [
        { title: "icu_2015.docx", page_id: 22 },
        { title: "icu_2015.docx", page_id: 23 },
        { title: "quy_trinh_icu_vn.docx", page_id: 400 },
        { title: "ssc_2021.docx", page_id: 40 },
      ],
    });
    expect(normalizeSources([final], "ards")).toEqual([
      {
        n: 1,
        source: "icu_2015.docx",
        title: "Hướng dẫn chẩn đoán và xử trí hồi sức tích cực — Bộ Y tế 2015",
        pages: ["22", "23"],
        verified: true,
      },
      {
        n: 2,
        source: "ssc_2021.docx",
        title: "Surviving Sepsis Campaign 2021",
        pages: ["40"],
        verified: true,
      },
    ]);
  });
});
