// Canonical ICU drug lexicon — single source of truth for the ASR drug matcher
// (port of src/asr/drug_lexicon.py). Seeded from the safety cross-reactivity
// groups plus common ICU drugs. Canonical English INN spellings.
import { ALLERGY_GROUPS } from "../safety/safety.js";

const ICU_DRUGS = [
  "Vancomycin", "Gentamicin", "Amikacin", "Tobramycin",
  "Norepinephrine", "Adrenalin", "Epinephrine", "Dopamine", "Dobutamine", "Vasopressin",
  "Meropenem", "Imipenem", "Ceftriaxone", "Cefepime", "Ceftazidime", "Cefotaxime",
  "Piperacillin", "Tazobactam", "Amoxicillin", "Ampicillin", "Penicillin",
  "Levofloxacin", "Ciprofloxacin", "Moxifloxacin", "Metronidazole", "Azithromycin", "Linezolid",
  "Colistin", "Sulfamethoxazole", "Trimethoprim",
  "Propofol", "Midazolam", "Fentanyl", "Morphine", "Ketamine", "Dexmedetomidine",
  "Heparin", "Enoxaparin", "Warfarin",
  "Insulin", "Furosemide", "Dexamethasone", "Hydrocortisone", "Amiodarone", "Digoxin",
  "Phenytoin", "Levetiracetam", "Fluconazole", "Amphotericin", "Paracetamol", "Ketorolac",
  "Noradrenaline",
];

// Drug *class* placeholders inside ALLERGY_GROUPS — excluded (would only create
// false fuzzy matches).
const CLASS_PLACEHOLDERS = new Set([
  "nsaid", "aminoglycoside", "quinolone", "sulfonamide", "sulfa", "cephalosporin",
]);

function buildLexicon() {
  const seen = new Map(); // lowercase -> canonical, de-duplicated, order-stable
  for (const name of ICU_DRUGS) {
    if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  for (const members of Object.values(ALLERGY_GROUPS)) {
    for (const m of members) {
      if (!CLASS_PLACEHOLDERS.has(m) && !seen.has(m)) {
        seen.set(m, m.charAt(0).toUpperCase() + m.slice(1));
      }
    }
  }
  return [...seen.values()];
}

export const DRUG_LEXICON = buildLexicon();
