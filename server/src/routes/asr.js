// Push-to-talk → transcript. Reads raw WAV bytes, sends to SmartVoice STT, runs
// the SUGGEST-only drug matcher. Returns {text, latency_s, suggestions}; never
// auto-sends or rewrites the transcript — the doctor confirms (F-ASR-04/05).
import { Router } from "express";
import { transcribe } from "../vnpt/smartvoice.js";
import { suggestDrugs } from "../asr/drugMatch.js";

const router = Router();

// express.raw() (mounted in index.js) puts the WAV bytes in req.body as a Buffer.
router.post("/asr/transcribe", async (req, res, next) => {
  const started = Date.now();
  try {
    const audio = req.body;
    if (!audio || !audio.length) return res.status(400).json({ detail: "empty audio" });

    const { text } = await transcribe(audio);
    res.json({
      text,
      latency_s: round((Date.now() - started) / 1000, 2),
      suggestions: suggestDrugs(text),
    });
  } catch (e) {
    next(e);
  }
});

function round(v, d) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

export default router;
