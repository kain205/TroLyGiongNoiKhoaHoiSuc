// Safety gate — allergy / contraindication / drug-interaction screening
// (port of src/rag/safety.py). check_allergies is pure; the OpenFDA checks throw
// on unavailable evidence and runSafetyScan preserves all completed results.
import { getInteractionText, getContraindicationText, findMention, norm } from "./openfda.js";

// ICD-description filler words: too generic to be a reliable contraindication trigger.
const CONDITION_STOPWORDS = new Set([
  "unspecified", "organism", "disease", "disorder", "syndrome", "other",
  "without", "with", "acute", "chronic", "type", "stage", "primary",
  "secondary", "complication", "complications", "finding", "status",
]);

// Cross-reactivity groups: an allergy to any member flags every member.
export const ALLERGY_GROUPS = {
  penicillin: ["penicillin", "amoxicillin", "ampicillin", "piperacillin", "oxacillin", "augmentin", "amoxicillin-clavulanate"],
  cephalosporin: ["cephalosporin", "cefazolin", "ceftriaxone", "cefepime", "cefotaxime", "ceftazidime", "cefuroxime", "cephalexin"],
  sulfonamide: ["sulfonamide", "sulfa", "sulfamethoxazole", "cotrimoxazole", "co-trimoxazole", "bactrim", "trimethoprim-sulfamethoxazole"],
  nsaid: ["aspirin", "ibuprofen", "diclofenac", "ketorolac", "naproxen", "nsaid"],
  aminoglycoside: ["gentamicin", "amikacin", "tobramycin", "aminoglycoside"],
  quinolone: ["ciprofloxacin", "levofloxacin", "moxifloxacin", "quinolone"],
};

function groupOf(drug) {
  const d = norm(drug);
  for (const [group, members] of Object.entries(ALLERGY_GROUPS)) {
    if (members.some((m) => d.includes(m))) return group;
  }
  return null;
}

// Alerts for query drugs that conflict with recorded allergies (direct name
// match or shared cross-reactivity group). Pure, no network.
export function checkAllergies(drugs, patientContext) {
  const alerts = [];
  const allergies = (patientContext || {}).allergies || [];
  for (const drug of drugs) {
    const d = norm(drug);
    if (!d) continue;
    const dGroup = groupOf(drug);
    for (const a of allergies) {
      const allergen = a.allergen || "";
      const al = norm(allergen);
      if (!al) continue;
      const direct = al.includes(d) || d.includes(al);
      const grouped = dGroup !== null && groupOf(allergen) === dGroup;
      if (direct || grouped) {
        alerts.push({
          type: "allergy",
          drug,
          allergen,
          criticality: a.criticality,
          reaction: a.reaction,
          match: direct ? "direct" : `cross-reactivity (${dGroup})`,
        });
      }
    }
  }
  return alerts;
}

// Screen query drugs against each other + the patient's current meds using
// OpenFDA interaction sections. Pairs de-duplicated (A↔B reported once).
export async function checkDrugInteractions(drugs, patientContext) {
  if (!drugs || !drugs.length) return [];
  let meds = ((patientContext || {}).medications || []).map((m) => (m.name || "").trim());
  meds = meds.filter(Boolean);
  const queryDrugs = drugs.map((d) => (d || "").trim()).filter(Boolean);

  const alerts = [];
  const seenPairs = new Set();
  for (const drug of queryDrugs) {
    const paras = await getInteractionText(drug);
    if (!paras.length) continue;
    const text = paras.join("\n");
    const candidates = [...queryDrugs.filter((d) => norm(d) !== norm(drug)), ...meds];
    for (const other of candidates) {
      const pairKey = [norm(drug), norm(other)].sort().join("|");
      if (norm(drug) === norm(other) || seenPairs.has(pairKey)) continue;
      const snippet = findMention(text, other);
      if (snippet) {
        seenPairs.add(pairKey);
        const source = meds.includes(other) ? "thuốc kê đơn" : "câu hỏi";
        alerts.push({
          type: "interaction",
          drug_a: drug,
          drug_b: other,
          other_source: source,
          snippet,
        });
      }
    }
  }
  return alerts;
}

function conditionTerms(patientContext) {
  const terms = []; // [searchTerm, displayLabel, wholeWord]
  const ctx = patientContext || {};
  const conds = ctx.conditions || [];
  for (const c of conds) {
    const label = c.name_vi || c.name_en || c.display || c.icd10_code || "?";
    const english = c.name_en || c.display || "";
    for (const tok of english.match(/[a-zA-Z]+/g) || []) {
      if (tok.length >= 5 && !CONDITION_STOPWORDS.has(tok.toLowerCase())) {
        terms.push([tok, label, true]);
      }
    }
  }
  // Pregnancy stem trigger (only if the English name doesn't already cover it).
  const englishBlob = norm(conds.map((c) => c.name_en || "").join(" "));
  const viBlob = norm(conds.map((c) => c.name_vi || "").join(" "));
  if (!englishBlob.includes("pregnan") && (viBlob.includes("thai") || viBlob.includes("pregnan"))) {
    terms.push(["pregnan", "Thai kỳ", false]);
  }
  return terms;
}

// Screen query drugs against the patient's conditions using OpenFDA
// contraindication sections. De-duplicated per (drug, condition).
export async function checkContraindications(drugs, patientContext) {
  if (!drugs || !drugs.length) return [];
  const terms = conditionTerms(patientContext);
  if (!terms.length) return [];

  const alerts = [];
  const seen = new Set();
  for (const drug of drugs.map((d) => (d || "").trim()).filter(Boolean)) {
    const paras = await getContraindicationText(drug);
    if (!paras.length) continue;
    const text = paras.join("\n");
    for (const [term, label, whole] of terms) {
      const key = `${norm(drug)}|${label}`;
      if (seen.has(key)) continue;
      const snippet = findMention(text, term, whole);
      if (snippet) {
        seen.add(key);
        alerts.push({ type: "contraindication", drug, condition: label, matched: term, snippet });
      }
    }
  }
  return alerts;
}

// Deterministic safety orchestration. Each evidence source is isolated so a
// transient OpenFDA failure can never erase allergy alerts already computed.
export async function runSafetyScan(drugs, patientContext, { unknownDrugs = [] } = {}) {
  const alerts = [];
  const failedChecks = [];
  const exactDrugs = [...new Set((drugs || []).filter(Boolean))];
  const unknown = [...new Set((unknownDrugs || []).filter(Boolean))];

  try {
    alerts.push(...checkAllergies(exactDrugs, patientContext));
  } catch {
    failedChecks.push("allergies");
  }

  try {
    alerts.push(...(await checkContraindications(exactDrugs, patientContext)));
  } catch {
    failedChecks.push("contraindications");
  }

  try {
    alerts.push(...(await checkDrugInteractions(exactDrugs, patientContext)));
  } catch {
    failedChecks.push("interactions");
  }

  const status = failedChecks.length
    ? "degraded"
    : unknown.length
      ? "unknown_drug"
      : "ok";

  return { alerts, status, failedChecks, unknownDrugs: unknown };
}

// Render alerts as the leading block of a response (allergy first).
export function formatAlerts(alerts) {
  if (!alerts || !alerts.length) return "";
  const allergy = alerts.filter((a) => (a.type || "allergy") === "allergy");
  const contra = alerts.filter((a) => a.type === "contraindication");
  const interaction = alerts.filter((a) => a.type === "interaction");

  const blocks = [];
  if (allergy.length) {
    const lines = ["⚠️ CẢNH BÁO DỊ ỨNG:"];
    for (const al of allergy) {
      const extra = al.reaction ? ` — phản ứng đã ghi nhận: ${al.reaction}` : "";
      const crit = al.criticality ? ` [${al.criticality}]` : "";
      lines.push(`  • ${al.drug} xung đột với dị ứng ${al.allergen} (${al.match})${crit}${extra}`);
    }
    blocks.push(lines.join("\n"));
  }
  if (contra.length) {
    const lines = ["⚠️ CẢNH BÁO CHỐNG CHỈ ĐỊNH (nguồn: nhãn thuốc FDA/OpenFDA):"];
    for (const ct of contra) {
      lines.push(`  • ${ct.drug} chống chỉ định liên quan ${ct.condition}: ${ct.snippet}`);
    }
    blocks.push(lines.join("\n"));
  }
  if (interaction.length) {
    const lines = ["⚠️ CẢNH BÁO TƯƠNG TÁC THUỐC (nguồn: nhãn thuốc FDA/OpenFDA):"];
    for (const it of interaction) {
      lines.push(`  • ${it.drug_a} ⇄ ${it.drug_b} (${it.other_source}): ${it.snippet}`);
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}
