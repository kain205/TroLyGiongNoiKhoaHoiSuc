// LOINC codes of interest (vital signs + ICU labs) — port of ALL_LOINC in src/fhir/fhir_client.py.
// Maps a LOINC code -> the short key used throughout the app.
export const LOINC_VITALS = {
  "59408-5": "spo2",
  "8867-4": "heart_rate",
  "9279-1": "resp_rate",
  "8480-6": "systolic_bp",
  "8462-4": "diastolic_bp",
  "8310-5": "temperature",
  "9267-6": "gcs",
};

export const LOINC_LABS = {
  "2160-0": "creatinine",
  "32693-4": "lactate",
  "1975-2": "bilirubin",
  "26464-8": "wbc",
  "777-3": "platelet",
  "718-7": "hemoglobin",
  "2703-7": "pao2",
  "2823-3": "potassium",
  "2951-2": "sodium",
};

export const ALL_LOINC = { ...LOINC_VITALS, ...LOINC_LABS };
