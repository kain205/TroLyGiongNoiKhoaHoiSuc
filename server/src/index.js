// ICU Clinical Assistant — Node.js orchestration backend over VNPT SmartBot + SmartVoice.
// Run:  npm start   (from server/)
import express from "express";
import cors from "cors";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  PORT,
  CORS_ORIGIN,
  ROOT,
  validateRequiredVnptConfig,
} from "./config.js";
import patientsRouter from "./routes/patients.js";
import asrRouter from "./routes/asr.js";
import ttsRouter from "./routes/tts.js";
import { NotFoundError } from "./patientStore.js";

validateRequiredVnptConfig();

const app = express();

app.use((req, res, next) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  next();
});

app.use(
  cors({
    origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",").map((s) => s.trim()),
  }),
);

// Body parsers: JSON for chat/tts, raw bytes for the WAV upload.
app.use(express.json({ limit: "2mb" }));
app.use(express.raw({ type: "audio/wav", limit: "15mb" }));

app.get("/api/health", (req, res) => res.json({ ok: true }));
app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send("User-agent: *\nDisallow: /\n");
});

app.use("/api", patientsRouter);
app.use("/api", asrRouter);
app.use("/api", ttsRouter);

// Serve the built SPA last so /api/* wins.
const DIST = resolve(ROOT, "frontend", "dist");
if (existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get("*", (req, res) => res.sendFile(resolve(DIST, "index.html")));
}

// Central error handler: NotFound -> 404, everything else -> 500 with detail.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof NotFoundError) return res.status(404).json({ detail: err.message });
  console.error("[error]", err);
  const status = Number.isInteger(err.statusCode) ? err.statusCode : 500;
  const payload = { detail: err.message || "internal error" };
  if (err.code) payload.code = err.code;
  res.status(status).json(payload);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ICU assistant backend listening on http://localhost:${PORT}`);
});
