// Post-ASR drug-name recovery — SUGGEST-only (port of src/asr/drug_match.py).
//
// ASR errors on drug names are near-miss phonetic garbles ("vancomy sin"→Vancomycin).
// This fuzzy-matches transcript spans against the ICU lexicon and proposes the
// intended drug so the confirm-box UI can offer the doctor the right name. It
// NEVER rewrites the transcript — auto-correcting a drug name is Risk #1.
import * as fuzzball from "fuzzball";
import { DRUG_LEXICON } from "./drugLexicon.js";

// Tuning (calibrated on the real-voice probe). WRatio garbles score 67-88; the
// lone false match scored 59, so floor 65 + a top1-top2 margin separate signal.
const SCORE_FLOOR = 65.0;
const MARGIN = 6.0;
const MAX_ALTERNATIVES = 3;

// Lowercase + drop diacritics (mirror of metrics._strip_diacritics).
function stripDiacritics(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/\p{Mn}/gu, "");
}

const LEX_NORM = DRUG_LEXICON.map(stripDiacritics);
const NORM_TO_CANON = new Map(LEX_NORM.map((n, i) => [n, DRUG_LEXICON[i]]));

// Drop leading/trailing punctuation so 'fenteno,' matches like 'fenteno'.
function clean(tok) {
  return tok.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

// Candidate spans: each token and each adjacent token-pair joined (to catch
// split garbles like 'vancomy sin'). Yields {surface, start, end, query}.
function* spans(transcript) {
  const raw = transcript.split(/\s+/).filter(Boolean);
  const toks = stripDiacritics(transcript)
    .split(/\s+/)
    .filter(Boolean)
    .map(clean);
  for (let i = 0; i < toks.length; i++) {
    yield { surface: raw[i], start: i, end: i, query: toks[i] };
  }
  for (let i = 0; i < toks.length - 1; i++) {
    yield { surface: `${raw[i]} ${raw[i + 1]}`, start: i, end: i + 1, query: toks[i] + toks[i + 1] };
  }
}

// Propose drug names for fuzzy-matching spans. Returns a list of
// {span, start, end, suggestion, score, alternatives} — highest score first,
// one per drug. Pure: does not modify the transcript.
export function suggestDrugs(transcript, scoreFloor = SCORE_FLOOR, margin = MARGIN) {
  const bestPerDrug = new Map();
  for (const { surface, start, end, query } of spans(transcript)) {
    if (query.length < 4) continue; // too short to be a reliable drug match
    const ranked = fuzzball.extract(query, LEX_NORM, {
      scorer: fuzzball.WRatio,
      limit: MAX_ALTERNATIVES + 1,
    });
    if (!ranked.length || ranked[0][1] < scoreFloor) continue;
    const [topNorm, topScore] = ranked[0];
    const suggestion = NORM_TO_CANON.get(topNorm);
    const second = ranked.length > 1 ? ranked[1][1] : 0.0;
    const alts =
      topScore - second < margin
        ? ranked.slice(1).filter(([, s]) => s >= scoreFloor).map(([n]) => NORM_TO_CANON.get(n))
        : [];
    const cand = {
      span: surface,
      start,
      end,
      suggestion,
      score: round(topScore, 1),
      alternatives: alts,
    };
    const prev = bestPerDrug.get(suggestion);
    if (!prev || cand.score > prev.score) bestPerDrug.set(suggestion, cand);
  }
  return [...bestPerDrug.values()].sort((a, b) => b.score - a.score);
}

function round(v, d) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
