const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const cases = JSON.parse(
  fs.readFileSync(path.join(__dirname, "clinical-regression-cases.json"), "utf-8"),
);
const apiBase = (process.env.API_BASE || "http://localhost:8000").replace(/\/+$/, "");
const patientId = process.env.EVAL_PATIENT_ID || "pt-001";

async function evaluate(testCase) {
  const started = Date.now();
  try {
    const response = await fetch(`${apiBase}/api/patients/${patientId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ query: testCase.query }),
      signal: AbortSignal.timeout(75_000),
    });
    const body = await response.json();
    const sources = Array.isArray(body.cited_sources) ? body.cited_sources : [];
    const checks = expectationChecks(testCase, body, sources);
    return {
      id: testCase.id,
      expected: testCase.intent,
      intent: body.intent || "",
      smartbot: body.smartbot_intent || "",
      fallback: Boolean(body.fallback),
      reason: body.fallback_reason || "",
      sources: sources.length,
      verified: sources.every((source) => source.verified === true),
      pass: response.ok && checks.every(Boolean),
      latency_s: ((Date.now() - started) / 1000).toFixed(2),
      answer: body.answer || "",
      source_titles: sources.map((source) => source.title || source.source),
    };
  } catch (error) {
    return {
      id: testCase.id,
      expected: testCase.intent,
      intent: "",
      smartbot: "",
      fallback: true,
      reason: error.message,
      sources: 0,
      verified: false,
      pass: false,
      latency_s: ((Date.now() - started) / 1000).toFixed(2),
      answer: "",
      source_titles: [],
    };
  }
}

function expectationChecks(testCase, body, sources) {
  const intentMatches = body.intent === testCase.intent;
  if (testCase.expect === "clinical_answer") {
    return [
      intentMatches,
      body.smartbot_intent === testCase.intent,
      body.fallback === false,
      sources.length >= 1 && sources.length <= 3,
      sources.every((source) => source.verified === true),
    ];
  }
  if (testCase.expect === "empty_answer") {
    return [
      intentMatches,
      body.fallback === true,
      body.fallback_reason === "empty_answer",
      sources.length === 0,
    ];
  }
  if (testCase.expect === "out_of_scope") {
    return [
      intentMatches,
      body.fallback === true,
      body.fallback_reason === "out_of_scope",
      body.smartbot_intent == null,
      sources.length === 0,
    ];
  }
  if (testCase.expect === "greeting") {
    return [
      intentMatches,
      body.fallback === false,
      body.smartbot_intent == null,
      sources.length === 0,
    ];
  }
  return [false];
}

async function main() {
  const results = [];
  for (const testCase of cases) results.push(await evaluate(testCase));

  console.table(results.map((result) => ({
    id: result.id,
    expected: result.expected,
    intent: result.intent,
    smartbot: result.smartbot,
    fallback: result.fallback,
    reason: result.reason,
    sources: result.sources,
    pass: result.pass,
    latency_s: result.latency_s,
  })));

  const failed = results.filter((result) => !result.pass);
  if (failed.length) {
    console.error(`Clinical regression failed: ${failed.length}/${results.length}`);
    for (const result of failed) {
      console.error(`\n#${result.id} ${cases.find((item) => item.id === result.id)?.query}`);
      console.error(`Answer: ${result.answer}`);
      console.error(`Sources: ${result.source_titles.join("; ") || "(none)"}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`Clinical regression passed: ${results.length}/${results.length}`);
}

main();
