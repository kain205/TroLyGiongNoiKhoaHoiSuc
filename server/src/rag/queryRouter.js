// Lightweight query router — keyword intent + drug extraction.
// Replaces the LLM router (src/rag/query_router.py) now that SmartBot handles
// generation; we only need intent (for the scoring directive) and the drug names
// to run the deterministic safety scan.
import { DRUG_LEXICON } from "../asr/drugLexicon.js";
import { norm } from "../safety/openfda.js";

const SAFETY_KW = ["chống chỉ định", "khong duoc dung", "không được dùng", "contraindication", "nguy hiểm", "phản vệ"];
const DOSING_KW = ["liều", "lieu", "dose", "mg/kg", "titrate", "chỉnh liều"];
const SCORING_KW = ["news2", "qsofa", "sofa", "egfr", "map", "điểm", "score"];

const LEX_NORM = DRUG_LEXICON.map((d) => [norm(d), d]);

// Returns { intent, drugs }. Intent ∈ {scoring, contraindication, dosing, general}.
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
  return { intent, drugs: [...new Set(drugs)] };
}
