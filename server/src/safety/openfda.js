// OpenFDA drug-label client for drug-drug interaction + contraindication screening
// (port of src/rag/openfda.py). Uses native fetch; every failure degrades to [].
//
// Caveats (on purpose): labels are unstructured prose, coverage is uneven, indexed
// by English generic/brand names — a missing alert is NOT a guarantee of safety.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { OPENFDA_API_KEY, DATA_DIR } from "../config.js";

const OPENFDA_LABEL_URL = "https://api.fda.gov/drug/label.json";
const TIMEOUT_MS = 6000;

const INTERACTION_FIELDS = ["drug_interactions", "drug_and_or_laboratory_test_interactions"];
const CONTRAINDICATION_FIELDS = ["contraindications"];

const _interactionCache = new Map(); // normalized drug -> string[]
const _contraindicationCache = new Map();

const CACHE_FILE = resolve(DATA_DIR, "openfda_cache.json");
_loadCache();

function _loadCache() {
  try {
    if (existsSync(CACHE_FILE)) {
      const data = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
      for (const [k, v] of Object.entries(data.interaction || {})) _interactionCache.set(k, v);
      for (const [k, v] of Object.entries(data.contraindication || {})) _contraindicationCache.set(k, v);
    }
  } catch {
    /* a corrupt cache must never break startup */
  }
}

function _persist() {
  try {
    const out = {
      interaction: Object.fromEntries(_interactionCache),
      contraindication: Object.fromEntries(_contraindicationCache),
    };
    writeFileSync(CACHE_FILE, JSON.stringify(out), "utf-8");
  } catch {
    /* best-effort */
  }
}

// Lowercase + strip Vietnamese diacritics for tolerant matching.
export function norm(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .trim();
}

async function _fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "vsf-rag/1.0" },
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(t);
  }
}

async function _getLabelSections(drug, fields, cache) {
  const key = norm(drug);
  if (!key) return [];
  if (cache.has(key)) return cache.get(key);

  const exists = fields.map((f) => `_exists_:${f}`).join(" OR ");
  let paras = [];
  for (const nameField of ["openfda.generic_name", "openfda.brand_name"]) {
    const params = new URLSearchParams({
      search: `${nameField}:"${key}" AND (${exists})`,
      limit: "1",
    });
    if (OPENFDA_API_KEY) params.set("api_key", OPENFDA_API_KEY);
    const url = `${OPENFDA_LABEL_URL}?${params.toString()}`;
    let data;
    try {
      data = await _fetchJson(url);
    } catch {
      continue; // unknown drug (404) / transient error -> try next field
    }
    const results = data.results || [];
    if (!results.length) continue;
    for (const fld of fields) {
      let val = results[0][fld] || [];
      if (typeof val === "string") val = [val];
      paras.push(...val.filter(Boolean));
    }
    if (paras.length) break;
  }

  cache.set(key, paras);
  _persist();
  return paras;
}

export function getInteractionText(drug) {
  return _getLabelSections(drug, INTERACTION_FIELDS, _interactionCache);
}

export function getContraindicationText(drug) {
  return _getLabelSections(drug, CONTRAINDICATION_FIELDS, _contraindicationCache);
}

// If `term` appears in `text`, return a trimmed snippet (the containing sentence,
// capped at 240 chars). Whole-word by default; pass wholeWord=false for stems.
export function findMention(text, term, wholeWord = true) {
  const name = norm(term);
  if (name.length < 4) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = wholeWord ? new RegExp(`\\b${escaped}\\b`) : new RegExp(escaped);
  if (!pattern.test(norm(text))) return null;
  for (const sentence of text.split(/(?<=[.;])\s+/)) {
    if (pattern.test(norm(sentence))) {
      const snippet = sentence.trim();
      return snippet.slice(0, 240) + (snippet.length > 240 ? "…" : "");
    }
  }
  return null;
}
