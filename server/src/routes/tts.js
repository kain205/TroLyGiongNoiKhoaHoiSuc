// Text-to-Speech: synthesize an answer with SmartVoice. Returns the hosted audio
// URL (cached 24h) so the frontend can play it directly via <audio src>.
import { Router } from "express";
import { synthesize } from "../vnpt/smartvoice.js";

const router = Router();

router.post("/tts/synthesize", async (req, res, next) => {
  try {
    const text = (req.body?.text || "").trim();
    if (!text) return res.status(400).json({ detail: "empty text" });
    const { audioLink, textId } = await synthesize(text);
    res.json({ audio_url: audioLink, text_id: textId });
  } catch (e) {
    next(e);
  }
});

export default router;
