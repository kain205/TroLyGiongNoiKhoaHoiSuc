// Context builder — patient summary + SmartBot system_prompt
// (port of src/rag/context_builder.py, adapted for VNPT SmartBot).
//
// Retrieval is delegated to SmartBot's knowledge base (ICU guidelines uploaded on
// the platform), so we no longer assemble retrieved chunks here. We inject the
// clinical role, patient data, and pre-computed safety alerts into system_prompt.

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
4. Nếu guideline không đủ để trả lời, nói rõ "Không đủ thông tin trong guideline" thay vì suy diễn.
5. Điểm số lâm sàng (NEWS2/qSOFA/SOFA/eGFR/MAP) đã được tính sẵn — dùng đúng giá trị, không tự tính lại.
6. Trả lời tối đa ~120 từ, súc tích để bác sĩ đọc trong 10 giây.
7. ĐỐI CHIẾU BỆNH NỀN: nếu bệnh nhân có bệnh nền (suy gan/thận/tim, thai kỳ...) và khuyến cáo cần điều chỉnh/thận trọng/chống chỉ định, BẮT BUỘC nêu rõ lưu ý đó kèm nguồn guideline. Không bịa lưu ý không có trong guideline.`;

// Assemble the full system_prompt to send to SmartBot (settings.system_prompt).
export function buildSystemPrompt(patientSummary, alertText, intentHint) {
  const parts = [SYSTEM_ROLE];
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
