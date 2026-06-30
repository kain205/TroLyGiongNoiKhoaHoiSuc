// Clinical calculations (MAP, qSOFA, SOFA, NEWS2, eGFR) — port of src/scoring/calculator.py.
//
// Reads only from a patient_context dict (no network, no hardcoded patient data),
// so calculateAll() is reusable independent of the FHIR layer.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getObsValue(observations, key) {
  const obs = observations[key];
  return obs ? obs.value : null;
}

// Numeric view of an observation value (pull leading number from strings like
// "10 (E2 V3 M5) - sedated"); null if not numeric. Booleans are not numbers.
export function getObsNumber(observations, key) {
  const v = getObsValue(observations, key);
  if (typeof v === "boolean") return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const m = v.match(/\s*(-?\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : null;
  }
  return null;
}

function getObsUnit(observations, key, def = "") {
  const obs = observations[key];
  return obs ? obs.unit || def : def;
}

function convertCreatinineToMgdl(value, unit) {
  if (value === null || value === undefined) return null;
  unit = (unit || "").toLowerCase();
  if (unit.includes("umol") || unit.includes("µmol")) return round(value / 88.4, 3);
  if (unit.includes("mg")) return round(value, 3);
  return null;
}

function convertBilirubinToMgdl(value, unit) {
  if (value === null || value === undefined) return null;
  unit = (unit || "").toLowerCase();
  if (unit.includes("umol") || unit.includes("µmol")) return round(value / 17.1, 3);
  return round(value, 3);
}

function agentClass(name) {
  const n = (name || "").toLowerCase();
  if (["norepinephrine", "noradrenaline", "norepi"].some((k) => n.includes(k))) return "norepi";
  if (["epinephrine", "adrenaline", "epi"].some((k) => n.includes(k))) return "epi";
  if (n.includes("dopamine")) return "dopamine";
  if (n.includes("dobutamine")) return "dobutamine";
  if (n.includes("vasopressin") || n.includes("phenylephrine")) return "other";
  return null;
}

function parseDose(doseStr) {
  const s = (doseStr || "").trim().toLowerCase();
  if (!s) return [null, false, false];
  const isRate = s.includes("/min") || s.includes("kg");
  const m = s.match(/(\d+(?:\.\d+)?)/);
  return [m ? parseFloat(m[1]) : null, isRate, true];
}

function cvScore(cls, value, isRate, hasDose) {
  if (cls === "dobutamine") return 2;
  if (cls === "dopamine") {
    if (!hasDose) return 3;
    if (!isRate) return 0;
    if (value === null) return 3;
    if (value <= 5) return 2;
    if (value <= 15) return 3;
    return 4;
  }
  if (cls === "norepi" || cls === "epi") {
    if (!hasDose) return 3;
    if (!isRate) return 0;
    return value !== null && value <= 0.1 ? 3 : 4;
  }
  if (cls === "other") {
    if (!hasDose) return 3;
    return !isRate ? 0 : 3;
  }
  return 0;
}

export function hasVasopressor(medications, administrations) {
  const agents = [];
  let maxScore = 0;
  let maxDose = null;
  for (const m of [...medications, ...administrations]) {
    const name = m.name || "";
    const cls = agentClass(name);
    if (!cls) continue;
    if (!agents.includes(name)) agents.push(name);
    const [value, isRate, hasDose] = parseDose(m.dose || "");
    const score = cvScore(cls, value, isRate, hasDose);
    if (score > maxScore) maxScore = score;
    if (isRate && value !== null && (maxDose === null || value > maxDose)) maxDose = value;
  }
  return { detected: agents.length > 0, agents, max_dose: maxDose, sofa_score: maxScore };
}

function hasHypercapnicRf(conditions) {
  const codes = ["J96.1", "J44"];
  const keywords = ["hypercapnic", "type 2 respiratory", "copd", "co2 retention", "chronic respiratory"];
  for (const c of conditions) {
    const code = c.icd10_code || "";
    const name = `${c.name_vi || ""} ${c.name_en || ""} ${c.display || ""}`.toLowerCase();
    if (codes.some((hc) => code.startsWith(hc))) return true;
    if (keywords.some((kw) => name.includes(kw))) return true;
  }
  return false;
}

function isOnOxygen(medications, administrations, procedures) {
  const keywords = ["oxygen", "nasal cannula", "face mask", "ventilat", "thở máy", "thở oxy", "thở ô-xy"];
  const allItems = [
    ...medications.map((m) => (m.name || "").toLowerCase()),
    ...administrations.map((m) => (m.name || "").toLowerCase()),
    ...procedures.map((p) => (p.name || "").toLowerCase()),
  ];
  for (const item of allItems) {
    if (!item) continue;
    if (keywords.some((kw) => item.includes(kw))) return true;
    if (/\bo2\b|\boxy\b/.test(item)) return true;
  }
  return false;
}

// bands: array of [predicate, score]; first match wins (else 0).
function scoreBands(value, bands) {
  for (const [pred, score] of bands) if (pred(value)) return score;
  return 0;
}

// ---------------------------------------------------------------------------
// MAP
// ---------------------------------------------------------------------------
export function calculateMap(observations) {
  const sbp = getObsNumber(observations, "systolic_bp");
  const dbp = getObsNumber(observations, "diastolic_bp");
  if (sbp === null || dbp === null) {
    return { value: null, sbp, dbp, interpretation: "Không đủ dữ liệu", missing: true };
  }
  const mapVal = round((sbp + 2 * dbp) / 3, 1);
  let interp;
  if (mapVal >= 70) interp = "Bình thường";
  else if (mapVal >= 65) interp = "Thấp — target MAP ≥ 65 (SSC 2021)";
  else interp = "Nghiêm trọng — cần vasopressor";
  return { value: mapVal, sbp, dbp, interpretation: interp, missing: false };
}

// ---------------------------------------------------------------------------
// qSOFA
// ---------------------------------------------------------------------------
export function calculateQsofa(observations) {
  const components = {};
  const missing = [];
  let total = 0;

  const gcs = getObsNumber(observations, "gcs");
  if (gcs !== null) {
    const score = gcs < 15 ? 1 : 0;
    total += score;
    components.gcs = { value: gcs, score, threshold: "< 15" };
  } else {
    missing.push("gcs");
    components.gcs = { value: null, score: 0, threshold: "< 15" };
  }

  const rr = getObsNumber(observations, "resp_rate");
  if (rr !== null) {
    const score = rr >= 22 ? 1 : 0;
    total += score;
    components.resp_rate = { value: rr, score, threshold: "≥ 22" };
  } else {
    missing.push("resp_rate");
    components.resp_rate = { value: null, score: 0, threshold: "≥ 22" };
  }

  const sbp = getObsNumber(observations, "systolic_bp");
  if (sbp !== null) {
    const score = sbp <= 100 ? 1 : 0;
    total += score;
    components.systolic_bp = { value: sbp, score, threshold: "≤ 100" };
  } else {
    missing.push("systolic_bp");
    components.systolic_bp = { value: null, score: 0, threshold: "≤ 100" };
  }

  const positive = total >= 2;
  const reliability = missing.length >= 2 ? "UNRELIABLE" : missing.length ? "PARTIAL" : "FULL";

  let interp;
  if (positive) interp = "DƯƠNG TÍNH — Nguy cơ cao sepsis/tử vong. Đánh giá chuyên sâu ngay.";
  else if (total === 1) interp = "Nguy cơ thấp — theo dõi tiếp";
  else interp = "Âm tính — không có dấu hiệu sepsis theo qSOFA";

  return {
    total,
    positive,
    components,
    interpretation: interp,
    missing_components: missing,
    reliability,
  };
}

// ---------------------------------------------------------------------------
// SOFA (5/6 organs; pulmonary skipped without FiO2)
// ---------------------------------------------------------------------------
export function calculateSofa(observations, conditions, medications, administrations) {
  const components = {};
  const missing = [];
  let total = 0;

  // Coagulation: platelet
  const plt = getObsNumber(observations, "platelet");
  if (plt !== null) {
    const sc = scoreBands(plt, [
      [(v) => v <= 20, 4],
      [(v) => v <= 50, 3],
      [(v) => v <= 100, 2],
      [(v) => v <= 150, 1],
    ]);
    components.coagulation = { score: sc, value: plt, missing: false };
    total += sc;
  } else {
    missing.push("coagulation");
    components.coagulation = { score: 0, value: null, missing: true };
  }

  // Liver: bilirubin (mg/dL)
  const biliRaw = getObsNumber(observations, "bilirubin");
  const bili = convertBilirubinToMgdl(biliRaw, getObsUnit(observations, "bilirubin", "mg/dL"));
  if (bili !== null) {
    const sc = scoreBands(bili, [
      [(v) => v >= 12.0, 4],
      [(v) => v >= 6.0, 3],
      [(v) => v >= 2.0, 2],
      [(v) => v >= 1.2, 1],
    ]);
    components.liver = { score: sc, value: bili, missing: false };
    total += sc;
  } else {
    missing.push("liver");
    components.liver = { score: 0, value: null, missing: true };
  }

  // Cardiovascular: vasopressor (≥2) supersedes MAP<70 (=1)
  const vaso = hasVasopressor(medications, administrations);
  const mapRes = calculateMap(observations);
  let cvScoreVal;
  let cvMissing;
  if (vaso.sofa_score > 0) {
    cvScoreVal = vaso.sofa_score;
    cvMissing = false;
  } else if (mapRes.value !== null) {
    cvScoreVal = mapRes.value < 70 ? 1 : 0;
    cvMissing = false;
  } else {
    cvScoreVal = 0;
    cvMissing = true;
    missing.push("cardiovascular");
  }
  components.cardiovascular = {
    score: cvScoreVal,
    vasopressor: vaso,
    map: mapRes.value,
    missing: cvMissing,
  };
  total += cvScoreVal;

  // Neurological: GCS
  const gcs = getObsNumber(observations, "gcs");
  if (gcs !== null) {
    const sc = scoreBands(gcs, [
      [(v) => v < 6, 4],
      [(v) => v <= 9, 3],
      [(v) => v <= 12, 2],
      [(v) => v <= 14, 1],
    ]);
    components.neurological = { score: sc, value: gcs, missing: false };
    total += sc;
  } else {
    missing.push("neurological");
    components.neurological = { score: 0, value: null, missing: true };
  }

  // Renal: creatinine (mg/dL)
  const crRaw = getObsNumber(observations, "creatinine");
  const cr = convertCreatinineToMgdl(crRaw, getObsUnit(observations, "creatinine", "umol/L"));
  if (cr !== null) {
    const sc = scoreBands(cr, [
      [(v) => v >= 5.0, 4],
      [(v) => v >= 3.5, 3],
      [(v) => v >= 2.0, 2],
      [(v) => v >= 1.2, 1],
    ]);
    components.renal = { score: sc, value: cr, missing: false };
    total += sc;
  } else {
    missing.push("renal");
    components.renal = { score: 0, value: null, missing: true };
  }

  // Pulmonary: skipped (FiO2 not modeled)
  components.pulmonary = { score: 0, value: null, missing: true };

  let mortality;
  if (total > 11) mortality = "Tử vong ước tính ≈ 95%";
  else if (total >= 2) mortality = "Tử vong ước tính ≈ 10% (SOFA ≥ 2 → Sepsis)";
  else mortality = "Nguy cơ thấp";

  const organs = ["coagulation", "liver", "cardiovascular", "neurological", "renal"];
  const scored = 5 - organs.filter((o) => missing.includes(o)).length;
  const reliability = scored >= 3 ? `PARTIAL(${scored})` : "UNRELIABLE";

  return {
    total,
    components,
    mortality_estimate: mortality,
    missing_components: missing,
    reliability,
    note: "Phổi (PaO₂/FiO₂) không tính do thiếu FiO₂; SOFA dựa trên 5 cơ quan.",
  };
}

// ---------------------------------------------------------------------------
// NEWS2
// ---------------------------------------------------------------------------
function news2Spo2Scale1(spo2) {
  return scoreBands(spo2, [
    [(v) => v <= 91, 3],
    [(v) => v <= 93, 2],
    [(v) => v <= 95, 1],
  ]);
}

function news2Spo2Scale2(spo2, onOxygen) {
  if (onOxygen) {
    return scoreBands(spo2, [
      [(v) => v >= 97, 3],
      [(v) => v >= 95, 2],
      [(v) => v >= 93, 1],
    ]);
  }
  return scoreBands(spo2, [
    [(v) => v <= 83, 3],
    [(v) => v <= 85, 2],
    [(v) => v <= 87, 1],
  ]);
}

export function calculateNews2(observations, conditions, medications, administrations, procedures) {
  const scale = hasHypercapnicRf(conditions) ? 2 : 1;
  const onOxygen = isOnOxygen(medications, administrations, procedures);

  const components = {};
  const missing = [];
  let total = 0;
  let anyThree = false;

  const add = (name, value, score, miss = false) => {
    components[name] = { value, score, missing: miss };
    if (!miss) {
      total += score;
      if (score === 3) anyThree = true;
    }
  };

  const rr = getObsNumber(observations, "resp_rate");
  if (rr !== null) {
    add("resp_rate", rr, scoreBands(rr, [
      [(v) => v <= 8, 3],
      [(v) => v >= 25, 3],
      [(v) => v >= 21, 2],
      [(v) => v <= 11, 1],
    ]));
  } else {
    missing.push("resp_rate");
    add("resp_rate", null, 0, true);
  }

  const spo2 = getObsNumber(observations, "spo2");
  if (spo2 !== null) {
    const sc = scale === 2 ? news2Spo2Scale2(spo2, onOxygen) : news2Spo2Scale1(spo2);
    add("spo2", spo2, sc);
  } else {
    missing.push("spo2");
    add("spo2", null, 0, true);
  }

  add("on_oxygen", onOxygen, onOxygen ? 2 : 0);

  const sbp = getObsNumber(observations, "systolic_bp");
  if (sbp !== null) {
    add("systolic_bp", sbp, scoreBands(sbp, [
      [(v) => v <= 90, 3],
      [(v) => v >= 220, 3],
      [(v) => v <= 100, 2],
      [(v) => v <= 110, 1],
    ]));
  } else {
    missing.push("systolic_bp");
    add("systolic_bp", null, 0, true);
  }

  const hr = getObsNumber(observations, "heart_rate");
  if (hr !== null) {
    add("heart_rate", hr, scoreBands(hr, [
      [(v) => v <= 40, 3],
      [(v) => v >= 131, 3],
      [(v) => v >= 111, 2],
      [(v) => v <= 50, 1],
      [(v) => v >= 91, 1],
    ]));
  } else {
    missing.push("heart_rate");
    add("heart_rate", null, 0, true);
  }

  const gcs = getObsNumber(observations, "gcs");
  if (gcs !== null) {
    add("gcs", gcs, gcs >= 15 ? 0 : 3);
  } else {
    missing.push("gcs");
    add("gcs", null, 0, true);
  }

  const temp = getObsNumber(observations, "temperature");
  if (temp !== null) {
    add("temperature", temp, scoreBands(temp, [
      [(v) => v <= 35.0, 3],
      [(v) => v >= 39.1, 2],
      [(v) => v >= 38.1, 1],
      [(v) => v <= 36.0, 1],
    ]));
  } else {
    missing.push("temperature");
    add("temperature", null, 0, true);
  }

  let risk;
  let riskVi;
  if (total >= 7) [risk, riskVi] = ["HIGH", "NGUY CƠ CAO"];
  else if (total >= 5) [risk, riskVi] = ["MEDIUM", "Nguy cơ trung bình"];
  else if (anyThree) [risk, riskVi] = ["MEDIUM-LOW", "Nguy cơ thấp-trung bình"];
  else if (total >= 1) [risk, riskVi] = ["LOW", "Nguy cơ thấp"];
  else [risk, riskVi] = ["LOW", "Nguy cơ thấp"];

  const reliability = missing.length >= 3 ? "UNRELIABLE" : missing.length ? "PARTIAL" : "FULL";

  return {
    total,
    risk_level: risk,
    risk_vi: riskVi,
    scale,
    on_oxygen: onOxygen,
    components,
    missing_components: missing,
    reliability,
    note: `NEWS2 Scale ${scale}` + (scale === 2 ? " (suy hô hấp tăng CO₂)" : ""),
  };
}

// ---------------------------------------------------------------------------
// eGFR (CKD-EPI 2021)
// ---------------------------------------------------------------------------
export function calculateEgfr(observations, patient) {
  const obs = observations.creatinine || {};
  let crValue = obs ? obs.value : null;
  const crUnit = (obs ? obs.unit : null) || "umol/L";
  if (typeof crValue === "string") crValue = null;

  const age = patient ? patient.age : null;
  if (crValue === null || crValue === undefined || age === null || age === undefined) {
    const reason = crValue === null || crValue === undefined ? "Thiếu Creatinine" : "Thiếu tuổi bệnh nhân";
    return {
      egfr: null,
      creatinine_mgdl: null,
      creatinine_umol: null,
      stage: "Unknown",
      stage_vi: "Không đủ dữ liệu",
      dose_adjustment: false,
      missing: true,
      note: `${reason} — không tính được eGFR`,
    };
  }

  const crMgdl = convertCreatinineToMgdl(crValue, crUnit);
  const ul = crUnit.toLowerCase();
  const crUmol = ul.includes("umol") || ul.includes("µmol") ? crValue : crValue * 88.4;

  const gender = (patient.gender || "male").toLowerCase();
  const female = ["female", "f", "nữ"].includes(gender);
  const kappa = female ? 0.7 : 0.9;
  const alpha = female ? -0.241 : -0.302;
  const sexFactor = female ? 1.012 : 1.0;

  const ratio = crMgdl / kappa;
  const egfr = round(
    142 *
      Math.min(ratio, 1) ** alpha *
      Math.max(ratio, 1) ** -1.2 *
      0.9938 ** age *
      sexFactor,
    1,
  );

  let stage;
  let stageVi;
  if (egfr >= 90) [stage, stageVi] = ["Stage 1", "Bình thường hoặc tăng"];
  else if (egfr >= 60) [stage, stageVi] = ["Stage 2", "Giảm nhẹ"];
  else if (egfr >= 45) [stage, stageVi] = ["Stage 3a", "Giảm nhẹ-vừa"];
  else if (egfr >= 30) [stage, stageVi] = ["Stage 3b", "Giảm vừa-nặng"];
  else if (egfr >= 15) [stage, stageVi] = ["Stage 4", "Giảm nặng"];
  else [stage, stageVi] = ["Stage 5", "Suy thận — xem xét lọc máu"];

  let note = "";
  if (egfr < 30) {
    note = "Suy thận nặng — điều chỉnh liều nghiêm trọng với Vancomycin, Gentamicin, kháng sinh thải qua thận";
  } else if (egfr < 60) {
    note = "Suy thận — cần điều chỉnh liều nhiều thuốc";
  }

  return {
    egfr,
    creatinine_mgdl: crMgdl,
    creatinine_umol: round(crUmol, 1),
    stage,
    stage_vi: stageVi,
    dose_adjustment: egfr < 60,
    note,
    missing: false,
  };
}

// ---------------------------------------------------------------------------
// calculate_all
// ---------------------------------------------------------------------------
export function calculateAll(patientContext) {
  const obs = patientContext.observations || {};
  const conds = patientContext.conditions || [];
  const meds = patientContext.medications || [];
  const admins = patientContext.medication_administrations || [];
  const procs = patientContext.procedures || [];
  const pat = patientContext.patient || {};

  const mapResult = calculateMap(obs);
  const qsofaResult = calculateQsofa(obs);
  const sofaResult = calculateSofa(obs, conds, meds, admins);
  const news2Result = calculateNews2(obs, conds, meds, admins, procs);
  const egfrResult = calculateEgfr(obs, pat);

  const alerts = [];
  if (news2Result.risk_level === "HIGH") alerts.push(`NEWS2 = ${news2Result.total} — MỨC ĐỘ CAO`);
  if (qsofaResult.positive) alerts.push("qSOFA ≥ 2 — Nguy cơ sepsis cao");
  if (mapResult.value !== null && mapResult.value < 65) {
    alerts.push(`MAP = ${mapResult.value} mmHg — Dưới ngưỡng (< 65)`);
  }
  if (egfrResult.dose_adjustment) alerts.push(`eGFR = ${egfrResult.egfr} — Cần điều chỉnh liều thuốc`);

  return {
    map: mapResult,
    qsofa: qsofaResult,
    sofa: sofaResult,
    news2: news2Result,
    egfr: egfrResult,
    summary: {
      alerts,
      alert_count: alerts.length,
      highest_risk: news2Result.risk_level,
      sepsis_screen: qsofaResult.positive,
    },
  };
}

// Python-style round-half-to-even to match the reference golden values.
function round(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return value;
  const f = 10 ** digits;
  const x = value * f;
  const r = Math.round(x);
  // round-half-to-even on exact .5
  const out = Math.abs(x - Math.trunc(x) - 0.5) < 1e-9 && r % 2 !== 0 ? r - 1 : r;
  return out / f;
}
