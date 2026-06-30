// VNPT SmartBot client — conversation API (base https://assistant-stream.vnpt.vn).
// Docs: docs/smartbot_docs/. Auth = Authorization Bearer + Token-id + Token-key.
//
// The endpoint may answer as plain JSON or as an SSE stream (card_data_info.status:
// 0 = final/no-stream, 1 = streaming chunk, 2 = final/with-stream). `ask` aggregates
// the whole reply; `askStream` yields the answer progressively for a live UI.
import { SB, vnptHeaders } from "../config.js";

const TIMEOUT_MS = 60000;

function buildBody(text, systemPrompt, { sessionId, senderId = "icu", advancePrompt = "" } = {}) {
  return {
    bot_id: SB.botId,
    sender_id: senderId,
    text,
    input_channel: "api",
    session_id: sessionId || `icu-${Date.now()}`,
    metadata: { button_variables: [] },
    settings: { system_prompt: systemPrompt || "", advance_prompt: advancePrompt || "null" },
  };
}

async function postConversation(text, systemPrompt, opts, signal) {
  return fetch(SB.url, {
    method: "POST",
    headers: {
      ...vnptHeaders(SB),
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(buildBody(text, systemPrompt, opts)),
    signal,
  });
}

// Non-streaming: returns { answer, audioUrls, cards, transferToAgent }.
export async function ask(text, systemPrompt, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let resp;
  let raw;
  try {
    resp = await postConversation(text, systemPrompt, opts, ctrl.signal);
    raw = await resp.text();
  } finally {
    clearTimeout(t);
  }
  if (!resp.ok) throw new Error(`SmartBot HTTP ${resp.status}: ${raw.slice(0, 200) || resp.statusText}`);
  return aggregate(parseEvents(raw));
}

// Streaming: async-generator yielding { answer } as the reply grows, then a final
// { answer, done: true, audioUrls, transferToAgent }. Auto-detects cumulative vs
// delta chunking; falls back to a single yield if the reply is plain JSON.
export async function* askStream(text, systemPrompt, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let resp;
  try {
    resp = await postConversation(text, systemPrompt, opts, ctrl.signal);
    if (!resp.ok) {
      const raw = await resp.text();
      throw new Error(`SmartBot HTTP ${resp.status}: ${raw.slice(0, 200) || resp.statusText}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let rawAll = "";
    let answer = "";
    let sawEvent = false;
    const audioUrls = [];
    let transferToAgent = false;

    const handleEvent = (obj) => {
      sawEvent = true;
      const ev = unwrap(obj);
      const cards = ev?.object?.sb?.card_data || [];
      const evText = cardsText(cards);
      for (const c of cards) {
        if (c.type === "chuyen_gdv") transferToAgent = true;
        if (c.audio_url) audioUrls.push(c.audio_url);
      }
      // cumulative if the new text extends what we have; else treat as a delta.
      if (evText) {
        if (evText.startsWith(answer)) answer = evText;
        else if (!answer.endsWith(evText)) answer += evText;
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      rawAll += text;
      buf += text;
      // SSE events are separated by blank lines; process complete ones.
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of block.split(/\r?\n/)) {
          const m = line.match(/^data:\s*(.*)$/);
          if (!m || !m[1].trim()) continue;
          const obj = tryParse(m[1]);
          if (obj) {
            handleEvent(obj);
            yield { answer };
          }
        }
      }
    }

    // No SSE events -> the reply was plain JSON; aggregate it in one shot.
    if (!sawEvent) {
      const agg = aggregate(parseEvents(rawAll));
      answer = agg.answer;
      audioUrls.push(...agg.audioUrls);
      transferToAgent = agg.transferToAgent;
      if (answer) yield { answer };
    }

    yield { answer, done: true, audioUrls, transferToAgent };
  } finally {
    clearTimeout(t);
  }
}

function cardsText(cards) {
  return cards
    .filter((c) => c.type === "text" || c.type === "quickreply")
    .map((c) => c.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

// Parse a full body into payload objects (plain JSON or SSE data lines).
function parseEvents(raw) {
  const out = [];
  const trimmed = raw.trim();
  if (trimmed.includes("data:")) {
    for (const line of trimmed.split(/\r?\n/)) {
      const m = line.match(/^data:\s*(.*)$/);
      if (!m || !m[1].trim()) continue;
      const obj = tryParse(m[1]);
      if (obj) out.push(unwrap(obj));
    }
    if (out.length) return out;
  }
  const obj = tryParse(trimmed);
  if (obj) out.push(unwrap(obj));
  return out;
}

function tryParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Some responses wrap the payload in {dataBase64, dataSign, ...}. Decode it.
function unwrap(obj) {
  if (obj && obj.dataBase64) {
    const decoded = tryParse(Buffer.from(obj.dataBase64, "base64").toString("utf-8"));
    if (decoded) return decoded;
  }
  return obj;
}

// Combine card_data across events into a single answer (prefer a final event).
function aggregate(events) {
  if (!events.length) return { answer: "", audioUrls: [], cards: [], transferToAgent: false };
  const statusOf = (ev) => ev?.object?.sb?.card_data_info?.status;
  const cardsOf = (ev) => ev?.object?.sb?.card_data || [];
  const finalEvent = events.find((ev) => statusOf(ev) === 0 || statusOf(ev) === 2);
  const cards = finalEvent ? cardsOf(finalEvent) : events.flatMap(cardsOf);

  const audioUrls = [];
  let transferToAgent = false;
  for (const c of cards) {
    if (c.type === "chuyen_gdv") transferToAgent = true;
    if (c.audio_url) audioUrls.push(c.audio_url);
  }
  return { answer: cardsText(cards), audioUrls, cards, transferToAgent };
}
