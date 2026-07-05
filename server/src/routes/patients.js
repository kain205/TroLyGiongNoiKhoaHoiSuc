// Patient endpoints: list, profile, opening assessment, chat.
import { Router } from "express";
import {
  listPatients,
  getProfile,
  getAssessment,
  ctxFor,
  NotFoundError,
} from "../patientStore.js";
import {
  summarizePatient,
  buildSystemPrompt,
  findMissingRequiredFields,
} from "../rag/contextBuilder.js";
import { routeQuery } from "../rag/queryRouter.js";
import {
  CLINICAL_DOMAIN_INTENTS,
  INSUFFICIENT_SENTINEL,
} from "../rag/clinicalPolicy.js";
import { formatAlerts, runSafetyScan } from "../safety/safety.js";
import { norm } from "../safety/openfda.js";
import { ask as askSmartBot, askStream as askSmartBotStream } from "../vnpt/smartbot.js";
import { SAFETY_FAIL_MODE } from "../config.js";
import { writeAuditLog } from "../audit/auditLog.js";

const router = Router();
const BOT_FALLBACK =
  "Không đủ thông tin trong guideline để trả lời an toàn. Vui lòng hỏi lại cụ thể hơn.";
const GREETING_ANSWER =
  "Xin chào. Tôi có thể hỗ trợ về sepsis/sốc nhiễm khuẩn, phản vệ, ARDS, AKI và các đánh giá an toàn theo bệnh nhân đang chọn.";
const OUT_OF_SCOPE =
  "Câu hỏi nằm ngoài phạm vi hỗ trợ hiện tại. Vui lòng hỏi về sepsis/sốc nhiễm khuẩn, phản vệ, ARDS, AKI hoặc đánh giá an toàn theo bệnh nhân.";
const BLOCK_GUIDANCE =
  "Không cung cấp nội dung tư vấn thuốc khi trạng thái an toàn chưa được xác minh. " +
  "Vui lòng kiểm tra hồ sơ, dược thư và xác nhận trực tiếp trước khi quyết định.";

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
  const requestId = `${req.params.pid}-${started}`;
  const auditBase = makeAuditBase(req, requestId, started);

  try {
    const { ctx, calc } = ctxFor(req.params.pid);
    const query = (req.body?.query || "").trim();
    auditBase.query = query;
    if (!query) {
      await auditResult(auditBase, started, {
        answer: "empty query",
        fallback: true,
        fallback_reason: "empty_query",
      });
      return res.status(400).json({ detail: "empty query", alerts: [] });
    }

    const prepared = await prepareChat(query, ctx, calc);
    Object.assign(auditBase, auditFromPrepared(prepared));
    const result = await resolveNonStreamingAnswer(query, req.params.pid, prepared);
    const payload = makePayload(requestId, started, prepared, result);

    await auditResult(auditBase, started, {
      ...result,
      answer: payload.answer,
      sources: payload.cited_sources,
    });
    res.json(payload);
  } catch (error) {
    await auditResult(auditBase, started, {
      answer: "",
      fallback: true,
      fallback_reason: "request_error",
      smartbot_trace: error.rawTrace || error.message,
    });
    next(error);
  }
});

// Streaming chat (SSE): deterministic meta always precedes SmartBot deltas.
// Terminal order after meta is delta* -> done, including SmartBot failures.
router.post("/patients/:pid/chat/stream", async (req, res) => {
  const started = Date.now();
  const requestId = `${req.params.pid}-${started}`;
  const auditBase = makeAuditBase(req, requestId, started);
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  let metaSent = false;
  let prepared;

  try {
    const { ctx, calc } = ctxFor(req.params.pid);
    const query = (req.body?.query || "").trim();
    auditBase.query = query;
    if (!query) {
      await auditResult(auditBase, started, {
        answer: "empty query",
        fallback: true,
        fallback_reason: "empty_query",
      });
      return res.status(400).json({ detail: "empty query", alerts: [] });
    }

    prepared = await prepareChat(query, ctx, calc);
    Object.assign(auditBase, auditFromPrepared(prepared));

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    send("meta", makeMeta(prepared));
    metaSent = true;

    const result = await resolveStreamingAnswer(
      query,
      req.params.pid,
      prepared,
      (answer) => send("delta", { answer }),
    );
    const payload = makePayload(requestId, started, prepared, result);
    send("done", payload);
    res.end();
    await auditResult(auditBase, started, {
      ...result,
      answer: payload.answer,
      sources: payload.cited_sources,
    });
  } catch (error) {
    if (metaSent && !res.writableEnded) {
      const result = {
        body: BOT_FALLBACK,
        fallback: true,
        fallback_reason: "smartbot_error",
        sources: [],
        smartbot_trace: error.rawTrace || error.message,
      };
      const safePrepared = prepared || emptyPrepared();
      const payload = makePayload(requestId, started, safePrepared, result);
      try {
        send("done", payload);
        res.end();
      } catch {
        res.end();
      }
      await auditResult(auditBase, started, {
        ...result,
        answer: payload.answer,
        sources: [],
      });
      return;
    }

    await auditResult(auditBase, started, {
      answer: "",
      fallback: true,
      fallback_reason: "request_error",
      smartbot_trace: error.rawTrace || error.message,
    });
    if (!res.headersSent) {
      res.status(error instanceof NotFoundError ? 404 : 500).json({
        detail: error.message,
        alerts: [],
      });
    } else {
      res.end();
    }
  }
});

async function prepareChat(query, ctx, calc) {
  const route = routeQuery(query);
  const deterministicOnly =
    route.domainIntent === "greeting" ||
    route.domainIntent === "out_of_scope" ||
    route.requiresExactDoseEvidence;
  const safety = deterministicOnly
    ? { alerts: [], status: "ok", failedChecks: [], unknownDrugs: route.unknownDrugs }
    : await runSafetyScan(route.drugs, ctx, {
        unknownDrugs: route.unknownDrugs,
      });
  const medicationRelevant =
    route.intent === "dosing" ||
    route.intent === "contraindication" ||
    route.drugs.length > 0 ||
    route.unknownDrugs.length > 0;
  const safetyUnverified = medicationRelevant && safety.status !== "ok";
  const alertText = formatAlerts(safety.alerts);
  const safetyBanner = safetyUnverified
    ? makeSafetyBanner([...route.drugs, ...route.unknownDrugs])
    : "";
  const missingFields = findMissingRequiredFields(
    route.intent,
    ctx,
    calc,
    route.scoreTargets,
  );
  const summary = summarizePatient(ctx, calc);
  const systemPrompt = buildSystemPrompt(summary, alertText, route.intent, {
    unverified: safetyUnverified,
    domainIntent: route.domainIntent,
  });

  return {
    ctx,
    calc,
    route,
    safety,
    medicationRelevant,
    safetyUnverified,
    alertText,
    safetyBanner,
    missingFields,
    systemPrompt,
  };
}

async function resolveNonStreamingAnswer(query, pid, prepared) {
  const deterministic = deterministicStop(prepared);
  if (deterministic) return deterministic;

  try {
    const bot = await askSmartBot(query, prepared.systemPrompt, {
      sessionId: pid,
      domainIntent: prepared.route.domainIntent,
    });
    return validateBotResult(bot, prepared);
  } catch (error) {
    return {
      body: BOT_FALLBACK,
      fallback: true,
      fallback_reason: "smartbot_error",
      sources: [],
      smartbot_intent: null,
      smartbot_trace: error.rawTrace || error.message,
    };
  }
}

async function resolveStreamingAnswer(query, pid, prepared, onDelta) {
  const deterministic = deterministicStop(prepared);
  if (deterministic) return deterministic;

  let answer = "";
  let transferToAgent = false;
  let finalChunk = {};
  try {
    for await (const chunk of askSmartBotStream(query, prepared.systemPrompt, {
      sessionId: pid,
      domainIntent: prepared.route.domainIntent,
    })) {
      answer = chunk.answer || answer;
      if (chunk.transferToAgent) transferToAgent = true;
      if (chunk.done) finalChunk = chunk;
      else onDelta(answer);
    }
  } catch (error) {
    return {
      body: BOT_FALLBACK,
      fallback: true,
      fallback_reason: "smartbot_error",
      sources: [],
      smartbot_intent: null,
      smartbot_trace: error.rawTrace || error.message,
    };
  }

  return validateBotResult({
    answer,
    transferToAgent,
    sources: finalChunk.sources || [],
    smartbotIntent: finalChunk.smartbotIntent || null,
    rawTrace: finalChunk.rawTrace || "",
  }, prepared);
}

function deterministicStop(prepared) {
  if (prepared.route.domainIntent === "greeting") {
    return {
      body: GREETING_ANSWER,
      fallback: false,
      fallback_reason: null,
      sources: [],
      smartbot_intent: null,
      smartbot_trace: "",
    };
  }
  if (prepared.route.domainIntent === "out_of_scope") {
    return {
      body: OUT_OF_SCOPE,
      fallback: true,
      fallback_reason: "out_of_scope",
      sources: [],
      smartbot_intent: null,
      smartbot_trace: "",
    };
  }
  if (prepared.route.requiresExactDoseEvidence) {
    return emptyAnswerResult();
  }
  if (prepared.missingFields.length) {
    return {
      body: `Thiếu ${prepared.missingFields.join(", ")} để tư vấn an toàn cho yêu cầu này.`,
      fallback: true,
      fallback_reason: "missing_required_fields",
      sources: [],
      smartbot_intent: null,
      smartbot_trace: "",
    };
  }
  if (
    prepared.safetyUnverified &&
    prepared.medicationRelevant &&
    SAFETY_FAIL_MODE === "block"
  ) {
    return {
      body: BLOCK_GUIDANCE,
      fallback: true,
      fallback_reason: "safety_unverified_block",
      sources: [],
      smartbot_intent: null,
      smartbot_trace: "",
    };
  }
  return null;
}

function makePayload(requestId, started, prepared, result) {
  return {
    answer: composeAnswer(prepared, result.body),
    alerts: prepared.safety.alerts,
    cited_sources: result.sources || [],
    safety_status: prepared.safety.status,
    safety_unverified: prepared.safetyUnverified,
    failed_checks: prepared.safety.failedChecks,
    unknown_drugs: prepared.safety.unknownDrugs,
    missing_fields: prepared.missingFields,
    fallback: Boolean(result.fallback),
    fallback_reason: result.fallback_reason || null,
    intent: prepared.route.domainIntent,
    smartbot_intent: result.smartbot_intent || null,
    timings_s: { total: round((Date.now() - started) / 1000, 2) },
    request_id: requestId,
  };
}

function makeMeta(prepared) {
  return {
    alerts: prepared.safety.alerts,
    alertText: prepared.alertText,
    safety_status: prepared.safety.status,
    safety_unverified: prepared.safetyUnverified,
    failed_checks: prepared.safety.failedChecks,
    unknown_drugs: prepared.safety.unknownDrugs,
    safety_banner: prepared.safetyBanner,
  };
}

function composeAnswer(prepared, body) {
  return [prepared.safetyBanner, prepared.alertText, body].filter(Boolean).join("\n\n");
}

function makeSafetyBanner(drugs) {
  const names = [...new Set(drugs.filter(Boolean))];
  const target = names.length ? names.join(", ") : "thuốc được hỏi";
  return `⚠️ CHƯA XÁC MINH ĐƯỢC AN TOÀN THUỐC cho ${target} — hãy kiểm tra thủ công.`;
}

function makeAuditBase(req, requestId, started) {
  const doctorHeader = req.get("x-doctor-id");
  return {
    request_id: requestId,
    ts_start: new Date(started).toISOString(),
    pid: req.params.pid,
    doctor_id: doctorHeader?.trim() || "unknown",
    query: "",
    intent: "unknown",
    drugs: [],
    alerts: [],
    safety_status: "unknown",
    safety_unverified: false,
  };
}

function auditFromPrepared(prepared) {
  return {
    intent: prepared.route.domainIntent,
    query_intent: prepared.route.intent,
    drugs: prepared.route.drugs,
    alerts: prepared.safety.alerts,
    safety_status: prepared.safety.status,
    safety_unverified: prepared.safetyUnverified,
  };
}

async function auditResult(base, started, result) {
  await writeAuditLog({
    ...base,
    ts_end: new Date().toISOString(),
    answer: result.answer || result.body || "",
    sources: result.sources || [],
    fallback: Boolean(result.fallback),
    latency_ms: Date.now() - started,
    smartbot_trace: result.smartbot_trace || result.fallback_reason || "",
    smartbot_intent: result.smartbot_intent || null,
  });
}

function emptyPrepared() {
  return {
    route: { domainIntent: "out_of_scope" },
    safety: { alerts: [], status: "degraded", failedChecks: [], unknownDrugs: [] },
    safetyUnverified: false,
    safetyBanner: "",
    alertText: "",
    missingFields: [],
  };
}

function validateBotResult(bot, prepared) {
  const body = (bot.answer || "").trim();
  const smartbotIntent = bot.smartbotIntent || null;
  const trace = bot.rawTrace || "";
  if (bot.transferToAgent) {
    return {
      body: BOT_FALLBACK,
      fallback: true,
      fallback_reason: "transfer_to_agent",
      sources: [],
      smartbot_intent: smartbotIntent,
      smartbot_trace: trace,
    };
  }
  if (!body || isInsufficientAnswer(body)) {
    return emptyAnswerResult(smartbotIntent, trace);
  }
  if (
    CLINICAL_DOMAIN_INTENTS.has(prepared.route.domainIntent) &&
    smartbotIntent !== prepared.route.domainIntent
  ) {
    return {
      body: BOT_FALLBACK,
      fallback: true,
      fallback_reason: "intent_mismatch",
      sources: [],
      smartbot_intent: smartbotIntent,
      smartbot_trace: trace,
    };
  }
  const sources = bot.sources || [];
  if (CLINICAL_DOMAIN_INTENTS.has(prepared.route.domainIntent) && !sources.length) {
    return emptyAnswerResult(smartbotIntent, trace);
  }
  return {
    body,
    fallback: false,
    fallback_reason: null,
    sources,
    smartbot_intent: smartbotIntent,
    smartbot_trace: trace,
  };
}

function emptyAnswerResult(smartbotIntent = null, trace = "") {
  return {
    body: BOT_FALLBACK,
    fallback: true,
    fallback_reason: "empty_answer",
    sources: [],
    smartbot_intent: smartbotIntent,
    smartbot_trace: trace,
  };
}

function isInsufficientAnswer(answer) {
  if (answer.includes(INSUFFICIENT_SENTINEL)) return true;
  const text = norm(answer);
  return [
    "khong du thong tin trong guideline",
    "khong cung cap con so cu the",
    "khong the dua ra con so",
    "khong co con so cu the",
    "khong tim thay can cu du",
    "khong co trong tai lieu",
  ].some((phrase) => text.includes(phrase));
}

function round(v, d) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

export { router, NotFoundError };
export default router;
