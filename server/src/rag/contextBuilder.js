// Context builder — patient summary + SmartBot system_prompt
// (port of src/rag/context_builder.py, adapted for VNPT SmartBot).
//
// Retrieval is delegated to SmartBot's knowledge base (ICU guidelines uploaded on
// the platform), so we no longer assemble retrieved chunks here. We inject the
// clinical role, patient data, and pre-computed safety alerts into system_prompt.
import {
  DOMAIN_SOURCE_POLICY,
  INSUFFICIENT_SENTINEL,
  SOURCE_CATALOG,
} from "./clinicalPolicy.js";

// Compact Vietnamese patient summary for the prompt (≈30 lines max).
export function summarizePatient(ctx, calc) {
  if (!ctx) return "(Không có dữ liệu bệnh nhân — trả lời theo guideline chung.)";
  const p = ctx.patient || {};
  const lines = [`Bệnh nhân: ${p.name ?? "?"} | ${p.gender ?? "?"} | ${p.age ?? "?"} tuổi`];

  const allergies = ctx.allergies || [];
  if (allergies.length) {
    const items = allergies.map((a) => `${a.allergen ?? "?"} (${a.criticality || "?"})`).join(", ");
    lines.push(`DỊ ỨNG: ${items}`);
  } else {
    lines.push("Dị ứng: không ghi nhận");
  }

  const conds = ctx.conditions || [];
  if (conds.length) {
    const items = conds
      .slice(0, 6)
      .map((c) => c.name_vi || c.display || c.icd10_code || "?")
      .join("; ");
    lines.push(`Chẩn đoán: ${items}`);
  }

  const obs = ctx.observations || {};
  const vals = [];
  const missing = [];
  for (const [key, o] of Object.entries(obs)) {
    if (o.value === null || o.value === undefined) missing.push(key);
    else vals.push(`${key}=${o.value}${o.unit || ""}`);
  }
  if (vals.length) lines.push("Chỉ số: " + vals.join(", "));
  if (missing.length) lines.push("THIẾU DỮ LIỆU: " + missing.join(", "));

  const meds = ctx.medications || [];
  if (meds.length) {
    const items = meds
      .slice(0, 8)
      .map((m) => `${m.name ?? "?"} ${m.dose || ""}`.trim())
      .join("; ");
    lines.push(`Thuốc đang dùng: ${items}`);
  }

  if (calc) {
    const s = [];
    const m = calc.map || {};
    if (m.value !== null && m.value !== undefined) s.push(`MAP=${m.value}`);
    const q = calc.qsofa || {};
    s.push(`qSOFA=${q.total ?? "?"}/3` + (q.positive ? " (DƯƠNG TÍNH)" : ""));
    const so = calc.sofa || {};
    s.push(`SOFA=${so.total ?? "?"}/24`);
    const n = calc.news2 || {};
    s.push(`NEWS2=${n.total ?? "?"} (${n.risk_level ?? "?"})`);
    const e = calc.egfr || {};
    if (e.egfr !== null && e.egfr !== undefined) s.push(`eGFR=${e.egfr} (${e.stage || ""})`);
    lines.push("Điểm số (đã tính sẵn, dùng đúng các giá trị này): " + s.join(" | "));
    for (const a of (calc.summary || {}).alerts || []) lines.push(`CẢNH BÁO: ${a}`);
  }
  return lines.join("\n");
}

// Clinical role + rules — adapted from src/prompts/generation.xml. The knowledge
// base (ICU guidelines) lives on the SmartBot platform; the bot retrieves from it.
const SYSTEM_ROLE = `Bạn là trợ lý lâm sàng ICU hỗ trợ bác sĩ. CHỈ trả lời dựa trên tri thức guideline đã nạp (Quy trình ICU BYT, Hồi sức tích cực BYT, TT-51 phản vệ, Surviving Sepsis Campaign) và DỮ LIỆU BỆNH NHÂN được cung cấp — tuyệt đối không dùng kiến thức ngoài.

Quy tắc bắt buộc:
1. TUYỆT ĐỐI không bịa số liệu (liều, thời gian, ngưỡng, giá trị) không có trong guideline. Nếu guideline không nêu con số → không tự thêm.
2. Khi đưa khuyến cáo, NÊU RÕ tên guideline làm nguồn (vd: "theo Surviving Sepsis Campaign", "theo Quy trình ICU BYT").
3. Nếu có CẢNH BÁO DỊ ỨNG/AN TOÀN trong dữ liệu bệnh nhân, câu đầu tiên phải nhắc lại cảnh báo đó.
4. Nếu guideline không đủ để trả lời, chỉ trả đúng mã ${INSUFFICIENT_SENTINEL}, không thêm giải thích.
5. Điểm số lâm sàng (NEWS2/qSOFA/SOFA/eGFR/MAP) đã được tính sẵn — dùng đúng giá trị, không tự tính lại.
6. Trả lời tối đa ~120 từ, súc tích để bác sĩ đọc trong 10 giây.
7. ĐỐI CHIẾU BỆNH NỀN: nếu bệnh nhân có bệnh nền (suy gan/thận/tim, thai kỳ...) và khuyến cáo cần điều chỉnh/thận trọng/chống chỉ định, nêu rõ lưu ý đó kèm nguồn guideline. Đây chỉ là lớp hướng dẫn mềm; KHÔNG tuyên bố đã xác minh an toàn nếu lớp deterministic không xác minh được. Cảnh báo deterministic/OpenFDA được cung cấp mới là kết quả kiểm tra an toàn của hệ thống.

TODO: mở rộng lớp deterministic bệnh-nền; không mở rộng quyền quyết định an toàn của LLM.`;

// Assemble the full system_prompt to send to SmartBot (settings.system_prompt).
export function buildSystemPrompt(patientSummary, alertText, intentHint, safetyContext = {}) {
  const parts = [SYSTEM_ROLE];
  const domainIntent = safetyContext.domainIntent;
  const allowedDocuments = (DOMAIN_SOURCE_POLICY[domainIntent] || [])
    .map((key) => SOURCE_CATALOG[key]?.title || key);
  if (domainIntent && allowedDocuments.length) {
    parts.push(
      "=== PHẠM VI RAG BẮT BUỘC ===\n" +
      `Intent: ${domainIntent}\n` +
      `Chỉ sử dụng tài liệu: ${allowedDocuments.join("; ")}.\n` +
      `Nếu các tài liệu này không chứa dữ kiện cần thiết, trả đúng ${INSUFFICIENT_SENTINEL}.`,
    );
  }
  if (safetyContext.unverified) {
    parts.push(
      "=== AN TOÀN THUỐC CHƯA XÁC MINH ===\n" +
      "Không được nói hoặc ngụ ý rằng thuốc đã được kiểm tra an toàn. " +
      "Chỉ trình bày thông tin guideline và yêu cầu bác sĩ kiểm tra thủ công.",
    );
  }
  if (alertText) {
    parts.push(`=== CẢNH BÁO AN TOÀN (bắt buộc nhắc lại đầu tiên) ===\n${alertText}`);
  }
  parts.push(`=== DỮ LIỆU BỆNH NHÂN ===\n${patientSummary}`);
  if (intentHint === "scoring") {
    parts.push(
      "=== LƯU Ý ===\nĐây là câu hỏi về ĐIỂM SỐ lâm sàng. Trả lời từ các điểm số đã tính sẵn (nêu rõ giá trị và mức nguy cơ).",
    );
  }
  return parts.join("\n\n");
}

// TODO(owner): confirm these default completeness criteria against the live FHIR
// contract. Empty medication/condition arrays are treated as missing for now.
export const REQUIRED_FIELDS = {
  dosing: ["egfr"],
  contraindication: ["current_medications", "conditions"],
  scoring: {
    map: ["systolic_bp", "diastolic_bp"],
    qsofa: ["gcs", "resp_rate", "systolic_bp"],
    news2: ["resp_rate", "spo2", "systolic_bp", "heart_rate", "gcs", "temperature"],
    egfr: ["creatinine", "patient_age"],
    sofa: ["coagulation", "liver", "cardiovascular", "neurological", "renal"],
  },
};

export function findMissingRequiredFields(intent, ctx, calc, scoreTargets = []) {
  if (intent === "dosing") {
    return calc?.egfr?.egfr == null ? ["eGFR"] : [];
  }
  if (intent === "contraindication") {
    const missing = [];
    if (!(ctx?.medications || []).length) missing.push("danh sách thuốc đang dùng");
    if (!(ctx?.conditions || []).length) missing.push("bệnh nền");
    return missing;
  }
  if (intent !== "scoring" || !scoreTargets.length) return [];

  const missing = [];
  const obs = ctx?.observations || {};
  const hasObs = (key) => obs[key]?.value !== null && obs[key]?.value !== undefined;
  const labels = {
    systolic_bp: "huyết áp tâm thu",
    diastolic_bp: "huyết áp tâm trương",
    gcs: "GCS",
    resp_rate: "nhịp thở",
    spo2: "SpO₂",
    heart_rate: "nhịp tim",
    temperature: "nhiệt độ",
    creatinine: "creatinine",
    patient_age: "tuổi bệnh nhân",
  };

  for (const target of scoreTargets) {
    if (target === "sofa") {
      for (const component of REQUIRED_FIELDS.scoring.sofa) {
        if (calc?.sofa?.components?.[component]?.missing) {
          missing.push(`thành phần SOFA ${component}`);
        }
      }
      continue;
    }
    for (const field of REQUIRED_FIELDS.scoring[target] || []) {
      const present = field === "patient_age" ? ctx?.patient?.age != null : hasObs(field);
      if (!present) missing.push(labels[field] || field);
    }
  }
  return [...new Set(missing)];
}
