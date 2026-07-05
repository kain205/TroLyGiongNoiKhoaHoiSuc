const path = require("node:path");
const { createRequire } = require("node:module");
const { randomUUID } = require("node:crypto");

const root = path.resolve(__dirname, "..");
const serverRequire = createRequire(path.join(root, "server", "package.json"));
serverRequire("dotenv").config({ path: path.join(root, "server", ".env") });

const requiredEnv = [
  "SB_URL",
  "SB_BOT_ID",
  "SB_ACCESS_TOKEN",
  "SB_TOKEN_ID",
  "SB_TOKEN_KEY",
];

for (const name of requiredEnv) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

const defaultQuestions = [
  "hi",
  "Mục tiêu MAP trong sốc nhiễm khuẩn theo Surviving Sepsis Campaign là bao nhiêu?",
  "asdfghjkl",
];
const cliQuestions = process.argv.slice(2).filter(Boolean);
const questions = cliQuestions.length ? cliQuestions : defaultQuestions;
const secrets = [
  process.env.SB_BOT_ID,
  process.env.SB_ACCESS_TOKEN,
  process.env.SB_TOKEN_ID,
  process.env.SB_TOKEN_KEY,
].filter(Boolean);

function redactSecrets(value) {
  let output = String(value || "");
  for (const secret of secrets) {
    output = output.split(secret).join("[CHE_TOKEN]");
  }
  return output;
}

function parseRawSseEvents(raw) {
  return raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter(Boolean)
    .flatMap((payload) => {
      try {
        return [JSON.parse(payload)];
      } catch {
        return [];
      }
    });
}

function summarizeRawEvents(raw) {
  const events = parseRawSseEvents(raw);
  const cards = events.flatMap((event) => event?.object?.sb?.card_data || []);
  const citations = events.flatMap((event) => {
    const citation = event?.object?.sb?.citation;
    return Array.isArray(citation) ? citation : citation == null ? [] : [citation];
  });
  const references = cards.flatMap((card) =>
    Array.isArray(card?.references)
      ? card.references
      : card?.references == null
        ? []
        : [card.references],
  );

  return {
    sse_event_count: events.length,
    card_count: cards.length,
    reference_count: references.length,
    citation_count: citations.length,
  };
}

async function runQuestion(index, text) {
  const body = {
    bot_id: process.env.SB_BOT_ID,
    session_id: randomUUID(),
    sender_id: "team.22@vnptai.io",
    input_channel: "livechat",
    stream: "1",
    user_auth_level: 2,
    tts_model: "news",
    tts_region: "female_north",
    metadata: {},
    settings: { enable_chunk_stream: 1 },
    text,
  };

  const response = await fetch(process.env.SB_URL, {
    method: "POST",
    headers: {
      Authorization: process.env.SB_ACCESS_TOKEN.startsWith("Bearer ")
        ? process.env.SB_ACCESS_TOKEN
        : `Bearer ${process.env.SB_ACCESS_TOKEN}`,
      "Token-id": process.env.SB_TOKEN_ID,
      "Token-key": process.env.SB_TOKEN_KEY,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  const raw = await response.text();
  console.log(`=== CÂU ${index} — HTTP ${response.status} ===`);
  console.log(`QUESTION: ${text}`);
  console.log("--- BEGIN RAW SSE ---");
  process.stdout.write(redactSecrets(raw));
  if (raw && !raw.endsWith("\n")) process.stdout.write("\n");
  console.log("--- END RAW SSE ---");
  console.log(`REPORT: ${JSON.stringify(summarizeRawEvents(raw), null, 2)}`);
}

async function main() {
  console.log(
    JSON.stringify(
      {
        SB_URL: process.env.SB_URL,
        SB_BOT_ID_CONFIGURED: Boolean(process.env.SB_BOT_ID),
      },
      null,
      2,
    ),
  );

  for (const [index, question] of questions.entries()) {
    await runQuestion(index + 1, question);
  }
}

main().catch((error) => {
  console.error(redactSecrets(error?.stack || String(error)));
  process.exitCode = 1;
});
