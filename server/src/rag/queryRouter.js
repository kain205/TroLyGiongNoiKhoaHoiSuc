// Lightweight query router — keyword intent + drug extraction.
// Replaces the LLM router (src/rag/query_router.py) now that SmartBot handles
// generation; we only need intent (for the scoring directive) and the drug names
// to run the deterministic safety scan.
import { DRUG_LEXICON } from "../asr/drugLexicon.js";
import { norm } from "../safety/openfda.js";
import * as fuzzball from "fuzzball";

const SAFETY_KW = ["chống chỉ định", "khong duoc dung", "không được dùng", "contraindication", "nguy hiểm", "phản vệ"];
const DOSING_KW = ["liều", "lieu", "dose", "mg/kg", "titrate", "chỉnh liều"];
const SCORING_KW = ["news2", "qsofa", "sofa", "egfr", "map", "điểm", "score"];

const LEX_NORM = DRUG_LEXICON.map((d) => [norm(d), d]);
const LEX_ONLY = LEX_NORM.map(([n]) => n);
const UNKNOWN_SCORE_FLOOR = 78;
const UNKNOWN_MARGIN = 8;
const GREETING_RE = /^(hi|hello|hey|xin chao|chao|chao ban|alo)[!,.?\s]*$/;
const PATIENT_SCORING_KW = [
  "benh nhan nay",
  "hien tai",
  "bao nhieu diem",
  "tinh diem",
  "nguy co cua benh nhan",
];
const OUT_OF_SCOPE_CLINICAL_KW = [
  "soc tim",
  "dot quy",
  "copd",
  "nhoi mau co tim",
  "xuat huyet tieu hoa",
  "viem tuy cap",
  "dong kinh",
  "hen ac tinh",
  "suy gan cap",
  "ngo doc",
];

// Returns exact drugs for deterministic scanning. Fuzzy matches are surfaced
// only as unknownDrugs; they are never silently promoted into a safety check.
export function routeQuery(query) {
  const q = norm(query);
  let intent = "general";
  if (SCORING_KW.some((k) => q.includes(norm(k)))) intent = "scoring";
  else if (SAFETY_KW.some((k) => q.includes(norm(k)))) intent = "contraindication";
  else if (DOSING_KW.some((k) => q.includes(norm(k)))) intent = "dosing";

  // Extract drug names: lexicon entries whose normalized form appears in the query.
  const drugs = [];
  for (const [n, canon] of LEX_NORM) {
    if (n.length >= 4 && q.includes(n)) drugs.push(canon);
  }
  const exactDrugs = [...new Set(drugs)];
  const unknownDrugs = detectUnknownDrugMentions(query, exactDrugs);
  const domainIntent = detectDomainIntent(q, intent, exactDrugs, unknownDrugs);
  const patientSpecificScoring =
    intent === "scoring" &&
    PATIENT_SCORING_KW.some((keyword) => q.includes(keyword));

  // A guideline question such as "MAP in septic shock" is not a request to
  // calculate the selected patient's MAP. Keep both classifications separate.
  if (domainIntent !== "deterministic" && intent === "scoring" && !patientSpecificScoring) {
    intent = "general";
  }
  if (domainIntent === "phan_ve" && intent === "contraindication" && !exactDrugs.length) {
    intent = "general";
  }

  return {
    intent,
    domainIntent,
    drugs: exactDrugs,
    unknownDrugs,
    scoreTargets: intent === "scoring" && patientSpecificScoring ? detectScoreTargets(q) : [],
    requiresExactDoseEvidence: requiresExactDoseEvidence(q, domainIntent, exactDrugs),
  };
}

function detectDomainIntent(q, intent, exactDrugs, unknownDrugs) {
  if (GREETING_RE.test(q)) return "greeting";
  if (
    q.includes("sepsis") ||
    q.includes("soc nhiem khuan") ||
    q.includes("nhiem trung huyet") ||
    q.includes("nhiem khuan nang")
  ) {
    return "sepsis_ssc";
  }
  if (
    q.includes("phan ve") ||
    (
      (q.includes("adrenalin") || q.includes("epinephrine")) &&
      q.includes("di ung") &&
      (q.includes("nang") || q.includes("tut huyet ap") || q.includes("soc"))
    )
  ) {
    return "phan_ve";
  }
  if (
    q.includes("ards") ||
    q.includes("berlin") ||
    (
      q.includes("suy ho hap cap") &&
      (
        q.includes("giam oxy") ||
        q.includes("thieu oxy") ||
        q.includes("pao2") ||
        q.includes("oxy mau")
      )
    )
  ) {
    return "ards";
  }
  if (
    q.includes("suy than cap") ||
    /\baki\b/.test(q) ||
    (
      (q.includes("creatinin") || q.includes("creatinine") || q.includes("chuc nang than")) &&
      (
        q.includes("khang sinh") ||
        q.includes("vancomycin") ||
        q.includes("lieu") ||
        q.includes("dieu chinh")
      )
    )
  ) {
    return "aki_lieu";
  }
  if (OUT_OF_SCOPE_CLINICAL_KW.some((keyword) => q.includes(keyword))) {
    return "out_of_scope";
  }
  if (intent !== "general" || exactDrugs.length || unknownDrugs.length) return "deterministic";
  return "out_of_scope";
}

function requiresExactDoseEvidence(q, domainIntent, exactDrugs) {
  if (domainIntent !== "aki_lieu") return false;
  if (!exactDrugs.some((drug) => norm(drug) === "vancomycin")) return false;
  return (
    q.includes("bao nhieu") ||
    q.includes("giam bao") ||
    (q.includes("lieu") && q.includes("giam")) ||
    (q.includes("lieu") && q.includes("dieu chinh cu the"))
  );
}

function detectScoreTargets(q) {
  const targets = [];
  if (q.includes("qsofa")) targets.push("qsofa");
  if (q.includes("news2")) targets.push("news2");
  if (q.includes("egfr")) targets.push("egfr");
  if (new RegExp("(^|\\s)map($|\\s)").test(q)) targets.push("map");
  if (new RegExp("(^|\\s)sofa($|\\s)").test(q) && !q.includes("qsofa")) targets.push("sofa");
  return targets;
}

function detectUnknownDrugMentions(query, exactDrugs) {
  const rawTokens = (query || "").split(/\s+/).filter(Boolean);
  const spans = [];
  for (let i = 0; i < rawTokens.length; i++) {
    spans.push(rawTokens[i]);
    if (i < rawTokens.length - 1) spans.push(`${rawTokens[i]} ${rawTokens[i + 1]}`);
  }

  const exactNorm = exactDrugs.map(norm);
  const unknown = [];
  for (const surface of spans) {
    const candidate = norm(surface).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (candidate.length < 5) continue;
    if (exactNorm.some((d) => candidate.includes(d) || d.includes(candidate))) continue;

    const ranked = fuzzball.extract(candidate.replace(/\s+/g, ""), LEX_ONLY, {
      scorer: fuzzball.WRatio,
      limit: 2,
    });
    if (!ranked.length) continue;
    const top = ranked[0][1];
    const second = ranked[1]?.[1] ?? 0;
    if (top >= UNKNOWN_SCORE_FLOOR && top - second >= UNKNOWN_MARGIN) {
      unknown.push(surface.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""));
    }
  }
  const unique = [...new Set(unknown.filter(Boolean))].sort((a, b) => b.length - a.length);
  return unique.filter((item, index) => {
    const itemNorm = norm(item);
    return !unique.slice(0, index).some((longer) => norm(longer).includes(itemNorm));
  });
}
