// Patient endpoints: list, profile, opening assessment, chat.
import { Router } from "express";
import {
  listPatients,
  getProfile,
  getAssessment,
  ctxFor,
  NotFoundError,
} from "../patientStore.js";
import { summarizePatient, buildSystemPrompt } from "../rag/contextBuilder.js";
import { routeQuery } from "../rag/queryRouter.js";
import {
  checkAllergies,
  checkContraindications,
  checkDrugInteractions,
  formatAlerts,
} from "../safety/safety.js";
import { ask as askSmartBot, askStream as askSmartBotStream } from "../vnpt/smartbot.js";

const router = Router();

router.get("/patients", (req, res) => {
  res.json(listPatients());
});

router.get("/patients/:pid", (req, res, next) => {
  try {
    res.json(getProfile(req.params.pid));
  } catch (e) {
    next(e);
  }
});

router.post("/patients/:pid/assessment", async (req, res, next) => {
  try {
    res.json(await getAssessment(req.params.pid));
  } catch (e) {
    next(e);
  }
});

router.post("/patients/:pid/chat", async (req, res, next) => {
  const started = Date.now();
  try {
    const { ctx, calc } = ctxFor(req.params.pid);
    const query = (req.body?.query || "").trim();
    if (!query) return res.status(400).json({ detail: "empty query" });

    // 1. Route + deterministic safety scan (runs BEFORE the LLM).
    const { intent, drugs } = routeQuery(query);
    let alerts = [];
    try {
      alerts = [
        ...checkAllergies(drugs, ctx),
        ...(await checkContraindications(drugs, ctx)),
        ...(await checkDrugInteractions(drugs, ctx)),
      ];
    } catch (exc) {
      console.error(`  [chat safety scan failed] ${exc}`);
    }
    const alertText = formatAlerts(alerts);

    // 2. Build system_prompt (clinical role + patient data + alerts) and ask SmartBot.
    const summary = summarizePatient(ctx, calc);
    const systemPrompt = buildSystemPrompt(summary, alertText, intent);
    const bot = await askSmartBot(query, systemPrompt, { sessionId: req.params.pid });

    // 3. Shape response. Safety alerts are prepended deterministically so they
    //    always show even if the model omits them.
    let answer = bot.answer || "";
    const fallback = !answer || bot.transferToAgent;
    if (fallback && !answer) {
      answer = "Không đủ thông tin trong guideline để trả lời an toàn. Vui lòng hỏi lại cụ thể hơn.";
    }
    if (alertText) answer = `${alertText}\n\n${answer}`;

    res.json({
      answer,
      alerts,
      cited_sources: [],
      fallback,
      fallback_reason: bot.transferToAgent ? "transfer_to_agent" : fallback ? "empty_answer" : null,
      timings_s: { total: round((Date.now() - started) / 1000, 2) },
      request_id: `${req.params.pid}-${started}`,
    });
  } catch (e) {
    next(e);
  }
});

// Streaming chat (SSE): safety alerts are sent immediately (deterministic), then
// the SmartBot answer streams in progressively. Events: meta | delta | done | error.
router.post("/patients/:pid/chat/stream", async (req, res) => {
  const started = Date.now();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    const { ctx, calc } = ctxFor(req.params.pid);
    const query = (req.body?.query || "").trim();
    if (!query) return res.status(400).json({ detail: "empty query" });

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // disable proxy buffering (nginx)
    });

    // 1. Deterministic safety scan first — emit alerts immediately.
    const { intent, drugs } = routeQuery(query);
    let alerts = [];
    try {
      alerts = [
        ...checkAllergies(drugs, ctx),
        ...(await checkContraindications(drugs, ctx)),
        ...(await checkDrugInteractions(drugs, ctx)),
      ];
    } catch (exc) {
      console.error(`  [chat safety scan failed] ${exc}`);
    }
    const alertText = formatAlerts(alerts);
    send("meta", { alerts, alertText });

    // 2. Stream the SmartBot answer.
    const summary = summarizePatient(ctx, calc);
    const systemPrompt = buildSystemPrompt(summary, alertText, intent);
    let answer = "";
    let transferToAgent = false;
    for await (const chunk of askSmartBotStream(query, systemPrompt, { sessionId: req.params.pid })) {
      answer = chunk.answer || answer;
      if (chunk.transferToAgent) transferToAgent = true;
      if (!chunk.done) send("delta", { answer });
    }

    // 3. Final shaping (alerts prepended deterministically).
    const fallback = !answer || transferToAgent;
    if (fallback && !answer) {
      answer = "Không đủ thông tin trong guideline để trả lời an toàn. Vui lòng hỏi lại cụ thể hơn.";
    }
    const finalAnswer = alertText ? `${alertText}\n\n${answer}` : answer;
    send("done", {
      answer: finalAnswer,
      alerts,
      cited_sources: [],
      fallback,
      fallback_reason: transferToAgent ? "transfer_to_agent" : fallback ? "empty_answer" : null,
      timings_s: { total: round((Date.now() - started) / 1000, 2) },
      request_id: `${req.params.pid}-${started}`,
    });
    res.end();
  } catch (e) {
    if (res.headersSent) {
      send("error", { detail: e.message });
      res.end();
    } else {
      res.status(500).json({ detail: e.message });
    }
  }
});

function round(v, d) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

export { router, NotFoundError };
export default router;
