export const CLINICAL_DOMAIN_INTENTS = new Set([
  "sepsis_ssc",
  "phan_ve",
  "ards",
  "aki_lieu",
]);

export const INSUFFICIENT_SENTINEL = "__INSUFFICIENT_GUIDELINE__";

export const DOMAIN_SOURCE_POLICY = {
  sepsis_ssc: ["ssc_2021.docx"],
  phan_ve: ["tt51_phan_ve.docx"],
  ards: ["icu_2015.docx", "ssc_2021.docx"],
  aki_lieu: ["icu_2015.docx"],
};

export const SOURCE_CATALOG = {
  "ssc_2021.docx": {
    source: "ssc_2021.docx",
    title: "Surviving Sepsis Campaign 2021",
    aliases: ["ssc_2021.docx", "ssc_2021.md", "surviving sepsis campaign 2021"],
  },
  "tt51_phan_ve.docx": {
    source: "tt51_phan_ve.docx",
    title: "Thông tư 51/2017/TT-BYT về phản vệ",
    aliases: ["tt51_phan_ve.docx", "tt51_phan_ve.md", "thông tư 51/2017/tt-byt"],
  },
  "icu_2015.docx": {
    source: "icu_2015.docx",
    title: "Hướng dẫn chẩn đoán và xử trí hồi sức tích cực — Bộ Y tế 2015",
    aliases: ["icu_2015.docx", "icu_2015.md", "hồi sức tích cực bộ y tế 2015"],
  },
  "quy_trinh_icu_vn.docx": {
    source: "quy_trinh_icu_vn.docx",
    title: "Quy trình kỹ thuật Hồi sức, Cấp cứu và Chống độc — Bộ Y tế 2014",
    aliases: ["quy_trinh_icu_vn.docx", "quy_trinh_icu_vn.md"],
  },
};

export function allowedSourceCatalog(domainIntent) {
  return (DOMAIN_SOURCE_POLICY[domainIntent] || [])
    .map((key) => [key, SOURCE_CATALOG[key]])
    .filter(([, value]) => Boolean(value));
}
