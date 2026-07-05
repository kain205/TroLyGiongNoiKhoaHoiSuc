// VNPT SmartBot client — conversation API (base https://assistant-stream.vnpt.vn).
// Docs: docs/smartbot_docs/. Auth = Authorization Bearer + Token-id + Token-key.
//
// The endpoint may answer as plain JSON or as an SSE stream (card_data_info.status:
// 0 = final/no-stream, 1 = streaming chunk, 2 = final/with-stream). `ask` aggregates
// the whole reply; `askStream` yields the answer progressively for a live UI.
import { SB, vnptHeaders } from "../config.js";
import { randomUUID } from "node:crypto";
import { allowedSourceCatalog } from "../rag/clinicalPolicy.js";

const TIMEOUT_MS = 60000;
const LOG_RAW_RESPONSE = process.env.SB_LOG_RAW === "1";
const SOURCE_KEYS = new Set([
  "source", "sources", "reference", "references", "citation", "citations",
]);

export class SmartBotError extends Error {
  constructor(message, { rawTrace = "", cause } = {}) {
    super(message, { cause });
    this.name = "SmartBotError";
    this.rawTrace = rawTrace;
  }
}

function buildBody(text, systemPrompt, {
  sessionId,
  senderId = "team.22@vnptai.io",
  advancePrompt = "null",
} = {}) {
  return {
    bot_id: SB.botId,
    session_id: sessionId || randomUUID(),
    sender_id: senderId,
    input_channel: "livechat",
    stream: "1",
    user_auth_level: 2,
    tts_model: "news",
    tts_region: "female_north",
    metadata: {},
    settings: {
      enable_chunk_stream: 1,
      system_prompt: systemPrompt || "",
      advance_prompt: advancePrompt,
    },
    text,
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
    logRawResponse("response", raw);
  } catch (error) {
    throw new SmartBotError(`SmartBot request failed: ${error.message}`, {
      rawTrace: raw || "",
      cause: error,
    });
  } finally {
    clearTimeout(t);
  }
  if (!resp.ok) {
    throw new SmartBotError(`SmartBot HTTP ${resp.status}: ${raw.slice(0, 200) || resp.statusText}`, {
      rawTrace: raw,
    });
  }
  const events = parseEvents(raw);
  return {
    ...aggregate(events),
    events,
    sources: normalizeSources(events, opts.domainIntent),
    smartbotIntent: collectSmartBotIntent(events),
    rawTrace: raw,
  };
}

// Streaming: async-generator yielding { answer } as the reply grows, then a final
// { answer, done: true, audioUrls, transferToAgent }. Auto-detects cumulative vs
// delta chunking; falls back to a single yield if the reply is plain JSON.
export async function* askStream(text, systemPrompt, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let resp;
  let rawAll = "";
  try {
    resp = await postConversation(text, systemPrompt, opts, ctrl.signal);
    if (!resp.ok) {
      const raw = await resp.text();
      throw new SmartBotError(`SmartBot HTTP ${resp.status}: ${raw.slice(0, 200) || resp.statusText}`, {
        rawTrace: raw,
      });
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let answer = "";
    let sawEvent = false;
    const audioUrls = [];
    let transferToAgent = false;
    const events = [];

    const handleEvent = (obj) => {
      sawEvent = true;
      const ev = unwrap(obj);
      events.push(ev);
      const cards = ev?.object?.sb?.card_data || [];
      const evText = cardsText(cards);
      const status = ev?.object?.sb?.card_data_info?.status;
      const isFinal =
        status === 0 ||
        status === 2 ||
        cards.some((card) => card?.status === 0 || card?.status === 2);
      for (const c of cards) {
        if (c.type === "chuyen_gdv") transferToAgent = true;
        if (c.audio_url && !audioUrls.includes(c.audio_url)) audioUrls.push(c.audio_url);
      }
      // Livechat chunk events are deltas, while status 0/2 is the complete clean
      // answer. The final text must replace the accumulated deltas: some deltas
      // contain literal "\\n", so appending the clean final event duplicates it.
      if (evText) {
        if (isFinal || evText.startsWith(answer)) answer = evText;
        else if (!answer.endsWith(evText)) answer += evText;
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      logRawResponse("stream chunk", text);
      rawAll += text;
      buf += text;
      // SSE events are separated by blank lines; process complete ones.
      let separator;
      while ((separator = buf.match(/\r?\n\r?\n/))) {
        const idx = separator.index;
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + separator[0].length);
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
      events.push(...parseEvents(rawAll));
      if (answer) yield { answer };
    }

    const cards = events.flatMap((ev) => ev?.object?.sb?.card_data || []);
    yield {
      answer,
      done: true,
      audioUrls,
      cards,
      events,
      sources: normalizeSources(events, opts.domainIntent),
      smartbotIntent: collectSmartBotIntent(events),
      rawTrace: rawAll,
      transferToAgent,
    };
  } catch (error) {
    if (error instanceof SmartBotError) throw error;
    throw new SmartBotError(`SmartBot stream failed: ${error.message}`, {
      rawTrace: rawAll,
      cause: error,
    });
  } finally {
    clearTimeout(t);
  }
}

function cardsText(cards) {
  return cards
    .filter((c) => c.type === "text" || c.type === "quickreply")
    .map((c) => normalizeText(c.text || ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizeText(text) {
  return text
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n");
}

function logRawResponse(label, raw) {
  if (LOG_RAW_RESPONSE) console.log(`[SmartBot raw ${label}]\n${raw}`);
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

// Checkpoint-only collection: preserve fields that already look like source
// metadata without asserting that they are valid citations.
export function collectSourceCandidates(value) {
  const found = [];
  const seen = new Set();

  const visit = (node, path = "") => {
    if (found.length >= 50 || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (SOURCE_KEYS.has(key.toLowerCase())) addCandidate(key, child, nextPath);
      visit(child, nextPath);
    }
  };

  const addCandidate = (field, raw, path) => {
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (found.length >= 50 || value === null || value === undefined) break;
      let signature;
      try {
        signature = `${field}:${JSON.stringify(value)}`;
      } catch {
        continue;
      }
      if (seen.has(signature)) continue;
      seen.add(signature);
      const object = typeof value === "object" && !Array.isArray(value) ? value : {};
      const source = typeof value === "string"
        ? value
        : object.source || object.name || object.title || String(value);
      found.push({
        n: found.length + 1,
        source,
        title: object.title || "",
        field,
        path,
        verified: false,
        raw: value,
      });
    }
  };

  visit(value);
  return found;
}

// Convert SmartBot's page-level references into a small, verified, document-level
// list. Unknown documents and documents outside the selected clinical intent are
// deliberately discarded.
export function normalizeSources(events, domainIntent) {
  const allowed = allowedSourceCatalog(domainIntent);
  if (!allowed.length || !Array.isArray(events) || !events.length) return [];

  const finalEvent = findFinalEvent(events);
  if (!finalEvent) return [];
  const sb = finalEvent?.object?.sb || {};
  const values = [];
  for (const card of sb.card_data || []) {
    if (Array.isArray(card?.references)) values.push(...card.references);
    else if (card?.references != null) values.push(card.references);
  }
  if (Array.isArray(sb.citation)) values.push(...sb.citation);
  else if (sb.citation != null) values.push(sb.citation);

  const grouped = new Map();
  for (const raw of values) {
    const key = matchSourceKey(raw, allowed);
    if (!key) continue;
    const pages = sourcePages(raw);
    if (!pages.length) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    const target = grouped.get(key);
    for (const page of pages) {
      if (!target.includes(page) && target.length < 5) target.push(page);
    }
  }

  return [...grouped.entries()].slice(0, 3).map(([key, pages], index) => {
    const catalog = allowed.find(([candidate]) => candidate === key)?.[1];
    return {
      n: index + 1,
      source: catalog.source,
      title: catalog.title,
      pages,
      verified: true,
    };
  });
}

export function collectSmartBotIntent(events) {
  let intent = "";
  for (const event of events || []) {
    const candidate = event?.object?.sb?.intent_name;
    if (typeof candidate === "string" && candidate.trim()) intent = candidate.trim();
  }
  return intent || null;
}

function findFinalEvent(events) {
  let finalEvent = null;
  for (const event of events) {
    const status = event?.object?.sb?.card_data_info?.status;
    const cards = event?.object?.sb?.card_data || [];
    if (
      status === 0 ||
      status === 2 ||
      cards.some((card) => card?.status === 0 || card?.status === 2)
    ) {
      finalEvent = event;
    }
  }
  return finalEvent || events.at(-1) || null;
}

function matchSourceKey(raw, allowed) {
  const object = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const label = typeof raw === "string"
    ? raw
    : object.file ||
      object.file_name ||
      object.filename ||
      object.name ||
      object.title ||
      object.source ||
      "";
  const normalized = String(label).toLowerCase().trim();
  if (!normalized) return null;
  for (const [key, catalog] of allowed) {
    if (catalog.aliases.some((alias) => normalized.includes(alias.toLowerCase()))) return key;
  }
  return null;
}

function sourcePages(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const page =
    raw.page_id ??
    raw.page ??
    raw.page_number ??
    raw.pageNumber ??
    raw.pages;
  if (Array.isArray(page)) return page.filter(validPage).map(String);
  return validPage(page) ? [String(page)] : [];
}

function validPage(page) {
  return page !== null && page !== undefined && String(page).trim() !== "";
}
