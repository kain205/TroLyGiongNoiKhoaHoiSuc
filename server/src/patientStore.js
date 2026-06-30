// Patient store + profile/assessment shaping (port of the data layer in src/web/app.py).
// Mock FHIR bundles are STATIC, so per-patient context/assessment are cached for the
// process lifetime (a live FHIR server would need a TTL + invalidation).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MOCK_DIR } from "./config.js";
import { FHIRClient } from "./fhir/fhirClient.js";
import { calculateAll } from "./scoring/calculator.js";
import { summarizePatient } from "./rag/contextBuilder.js";
import { checkAllergies, checkContraindications, checkDrugInteractions } from "./safety/safety.js";

const GENDER_VI = { male: "Nam", female: "Nữ", other: "Khác", unknown: "Không rõ" };

const INDEX = JSON.parse(readFileSync(resolve(MOCK_DIR, "index.json"), "utf-8"));
const PATIENTS = INDEX.patients;
const ID_TO_FILE = Object.fromEntries(PATIENTS.map((p) => [p.id, p.file]));

const _ctxCache = new Map(); // pid -> { ctx, calc }
const _assessmentCache = new Map();
const _demographicsCache = new Map();

export class NotFoundError extends Error {}

// (ctx, calc) for a patient id; cached (static-mock only).
export function ctxFor(pid) {
  if (!(pid in ID_TO_FILE)) throw new NotFoundError(`unknown patient '${pid}'`);
  if (!_ctxCache.has(pid)) {
    const client = FHIRClient.fromFile(resolve(MOCK_DIR, ID_TO_FILE[pid]));
    const ctx = client.buildPatientContext();
    _ctxCache.set(pid, { ctx, calc: calculateAll(ctx) });
  }
  return _ctxCache.get(pid);
}

// Light demographics for the selector (Patient resource only).
function demographics(pid, file) {
  if (!_demographicsCache.has(pid)) {
    const p = FHIRClient.fromFile(resolve(MOCK_DIR, file)).getPatient();
    _demographicsCache.set(pid, { gender: p.gender, birthDate: p.birthDate, age: p.age });
  }
  return _demographicsCache.get(pid);
}

export function listPatients() {
  return PATIENTS.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description || "",
    ...demographics(p.id, p.file),
  }));
}

// Shape build_patient_context() + calculate_all() into a flat profile for the UI.
export function toProfile(ctx, calc) {
  const p = ctx.patient || {};
  const enc = ctx.encounter || {};
  const vitals = Object.entries(ctx.observations || {})
    .filter(([, o]) => o.value !== null && o.value !== undefined)
    .map(([k, o]) => ({ key: k, value: o.value, unit: o.unit || "" }));
  const scores = {
    map: (calc.map || {}).value,
    qsofa: (calc.qsofa || {}).total,
    qsofa_positive: (calc.qsofa || {}).positive,
    sofa: (calc.sofa || {}).total,
    news2: (calc.news2 || {}).total,
    news2_risk: (calc.news2 || {}).risk_level,
    egfr: (calc.egfr || {}).egfr,
    egfr_stage: (calc.egfr || {}).stage,
  };
  return {
    id: ctx.patient_id,
    name: p.name || "?",
    age: p.age ?? null,
    gender: p.gender ?? null,
    encounter: {
      service_type: enc.service_type ?? null,
      class: enc.class ?? null,
      period_start: enc.period_start ?? null,
      reasons: enc.reasons || [],
    },
    allergies: (ctx.allergies || []).map((a) => ({
      allergen: a.allergen,
      criticality: a.criticality,
      reaction: a.reaction,
    })),
    conditions: (ctx.conditions || []).map((c) => c.name_vi || c.display || c.icd10_code || "?"),
    medications: (ctx.medications || []).map((m) => ({ name: m.name, dose: m.dose })),
    vitals,
    scores,
    alerts: (calc.summary || {}).alerts || [],
    summary: summarizePatient(ctx, calc),
  };
}

export function getProfile(pid) {
  const { ctx, calc } = ctxFor(pid);
  return toProfile(ctx, calc);
}

function normalizeDrugAlert(a) {
  if (a.type === "allergy") {
    let detail = `Đang dùng thuốc trùng dị ứng đã ghi nhận (${a.allergen})`;
    if (a.reaction) detail += ` — phản ứng: ${a.reaction}`;
    return { type: a.type, severity: "danger", title: `Dị ứng × thuốc: ${a.drug}`, detail };
  }
  if (a.type === "contraindication") {
    return {
      type: a.type,
      severity: "danger",
      title: `Chống chỉ định: ${a.drug} ↔ ${a.condition}`,
      detail: (a.snippet || "").trim().slice(0, 240),
    };
  }
  if (a.type === "interaction") {
    return {
      type: a.type,
      severity: "warn",
      title: `Tương tác thuốc: ${a.drug_a} ↔ ${a.drug_b}`,
      detail: (a.snippet || "").trim().slice(0, 240),
    };
  }
  return { type: a.type || "alert", severity: "warn", title: a.drug || "Cảnh báo an toàn", detail: "" };
}

// Deterministic opening assessment (no LLM): score flags + allergies + best-effort
// OpenFDA drug-safety scan over current medications.
export async function buildAssessment(ctx, calc) {
  const profile = toProfile(ctx, calc);
  const meds = profile.medications.map((m) => m.name).filter(Boolean);
  let drugAlerts = [];
  try {
    const raw = [
      ...checkAllergies(meds, ctx),
      ...(await checkContraindications(meds, ctx)),
      ...(await checkDrugInteractions(meds, ctx)),
    ];
    drugAlerts = raw.map(normalizeDrugAlert);
  } catch (exc) {
    console.error(`  [assessment safety scan failed] ${exc}`);
  }

  const subtitle = [
    GENDER_VI[profile.gender] || profile.gender,
    profile.age !== null && profile.age !== undefined ? `${profile.age} tuổi` : null,
    (profile.encounter || {}).service_type,
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    kind: "assessment",
    name: profile.name,
    subtitle,
    score_flags: (calc.summary || {}).alerts || [],
    allergies: profile.allergies,
    drug_alerts: drugAlerts,
    conditions: profile.conditions,
    note:
      "Tóm tắt tự động từ hồ sơ bệnh nhân — không phải khuyến nghị điều trị. " +
      "Đặt câu hỏi bên dưới để nhận tư vấn có trích dẫn guideline.",
  };
}

export async function getAssessment(pid) {
  const { ctx, calc } = ctxFor(pid);
  if (!_assessmentCache.has(pid)) {
    _assessmentCache.set(pid, await buildAssessment(ctx, calc));
  }
  return _assessmentCache.get(pid);
}
