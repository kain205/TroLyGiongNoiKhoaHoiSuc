// FHIR R4 patient-context builder — mock-bundle mode only (port of src/fhir/fhir_client.py).
//
// Reads a local FHIR Bundle JSON and consolidates 9 resource types into one
// patient_context object (demographics, encounter, allergies, vitals/labs,
// medications, conditions, administrations, procedures, diagnostic reports).
//
// The live SMART Health IT HTTP path and the SQLite LOINC/ICD-10 lookups from the
// Python version are dropped: mock bundles carry their own code.text, and the
// LOINC short-name is only used for a display label that falls back to the key.
import { readFileSync } from "node:fs";
import { ALL_LOINC } from "./loinc.js";

export class FHIRClient {
  constructor(bundle) {
    this.bundle = bundle;
    this.patientId = "mock-patient";
    for (const e of bundle.entry || []) {
      if (e.resource?.resourceType === "Patient") {
        this.patientId = e.resource.id || this.patientId;
        break;
      }
    }
  }

  static fromFile(filepath) {
    const bundle = JSON.parse(readFileSync(filepath, "utf-8"));
    return new FHIRClient(bundle);
  }

  // All resources of a given type from the loaded bundle.
  _all(resourceType) {
    return (this.bundle.entry || [])
      .map((e) => e.resource)
      .filter((r) => r?.resourceType === resourceType);
  }

  // ---- 4.1 AllergyIntolerance ----
  getAllergies() {
    return this._all("AllergyIntolerance").map((r) => {
      const code = r.code || {};
      let allergen = code.text;
      if (!allergen && code.coding?.length) allergen = code.coding[0].display;
      let reaction = null;
      const reactions = r.reaction || [];
      if (reactions.length) {
        const manifestation = reactions[0].manifestation || [];
        if (manifestation.length) {
          reaction = manifestation[0].text;
          if (!reaction && manifestation[0].coding?.length) {
            reaction = manifestation[0].coding[0].display;
          }
        }
      }
      return {
        allergen: allergen ?? null,
        category: (r.category || [null])[0],
        criticality: r.criticality ?? null,
        reaction: reaction ?? null,
      };
    });
  }

  // ---- 4.2 Patient ----
  getPatient() {
    const r = this._all("Patient")[0];
    if (!r) return {};
    const name = (r.name || [{}])[0];
    const display =
      name.text ||
      `${name.family || ""} ${(name.given || []).join(" ")}`.trim();
    const birth = r.birthDate;
    let age = null;
    if (birth) {
      const bd = new Date(birth);
      if (!Number.isNaN(bd.getTime())) age = yearsSince(bd);
    }
    return {
      id: r.id,
      name: display || "?",
      gender: r.gender,
      birthDate: birth,
      age,
    };
  }

  // ---- 4.3 Encounter ----
  getEncounter() {
    const r = this._all("Encounter")[0];
    if (!r) return {};
    const cls = r.class || {};
    const service = r.serviceType || {};
    let serviceType = service.text;
    if (!serviceType && service.coding?.length) serviceType = service.coding[0].display;
    return {
      id: r.id,
      status: r.status,
      class: cls.code,
      service_type: serviceType ?? null,
      period_start: r.period?.start ?? null,
      reasons: (r.reasonCode || []).map((rc) => (rc.coding?.[0] || {}).display),
      locations: (r.location || []).map((loc) => (loc.location || {}).display),
    };
  }

  // ---- 4.4 Observation ----
  static _findLoincCode(coding) {
    for (const c of coding) if (c.code in ALL_LOINC) return c.code;
    return null;
  }

  static _extractValue(r) {
    if (r.valueQuantity) return [r.valueQuantity.value, r.valueQuantity.unit || ""];
    if (r.valueCodeableConcept) return [r.valueCodeableConcept.text, ""];
    if (r.component) {
      for (const comp of r.component) {
        const codes = (comp.code?.coding || []).map((c) => c.code);
        if (codes.includes("8480-6") && comp.valueQuantity) {
          return [comp.valueQuantity.value, comp.valueQuantity.unit || ""];
        }
      }
    }
    return [null, null];
  }

  getObservations() {
    // Seed every key so missing indices stay visible as null.
    const result = {};
    for (const [code, name] of Object.entries(ALL_LOINC)) {
      result[name] = { value: null, unit: null, timestamp: null, loinc: code, name };
    }

    for (const r of this._all("Observation")) {
      const coding = r.code?.coding || [];
      const code = FHIRClient._findLoincCode(coding);
      if (!code) continue;
      const key = ALL_LOINC[code];
      const ts = r.effectiveDateTime || r.issued || "";
      const existing = result[key];
      // keep the most recent reading
      if (existing.value !== null && existing.timestamp && ts && ts <= existing.timestamp) {
        continue;
      }
      let [value, unit] = FHIRClient._extractValue(r);
      if (value === null || value === undefined) continue;
      if (typeof value === "number" && !Number.isInteger(value)) value = round(value, 1);
      // unit conversions
      const ul = (unit || "").toLowerCase();
      if (key === "creatinine" && ul.includes("mg/dl")) {
        value = round(value * 88.4, 1);
        unit = "µmol/L";
      } else if (key === "temperature" && ["[degf]", "degf", "f"].includes(ul)) {
        value = round(((value - 32) * 5) / 9, 1);
        unit = "°C";
      }
      result[key] = { value, unit, timestamp: ts, loinc: code, name: key };
    }
    return result;
  }

  // ---- 4.5 MedicationRequest ----
  static _medName(r) {
    const mcc = r.medicationCodeableConcept || {};
    if (mcc.text) return mcc.text;
    if (mcc.coding?.length) return mcc.coding[0].display;
    return r.medicationReference?.display ?? null;
  }

  getMedications() {
    return this._all("MedicationRequest").map((r) => {
      const di = (r.dosageInstruction || [{}])[0];
      const dar = (di.doseAndRate || [{}])[0];
      const dq = dar.doseQuantity || {};
      const dose = `${dq.value ?? ""} ${dq.unit ?? ""}`.trim();
      const route = ((di.route?.coding || [{}])[0] || {}).display || "";
      const frequency = di.timing?.code?.text || "";
      return { name: FHIRClient._medName(r), dose, route, frequency };
    });
  }

  // ---- 4.6 Condition ----
  getConditions() {
    return this._all("Condition").map((r) => {
      const codeBlock = r.code || {};
      const coding = codeBlock.coding || [];
      let icdCode = null;
      let icdDisplay = "";
      for (const c of coding) {
        const system = (c.system || "").toLowerCase();
        if (system.includes("icd-10") || system.includes("icd10")) {
          icdCode = c.code;
          icdDisplay = c.display || "";
          break;
        }
      }
      if (!icdCode && coding.length) icdCode = coding[0].code;
      const fhirText = codeBlock.text;
      const fhirDisplay = icdDisplay || (coding.length ? coding[0].display : "");
      const nameVi = fhirText || "";
      const nameEn = fhirDisplay || "";
      const display = fhirText || fhirDisplay || "";
      return {
        icd10_code: icdCode || "?",
        name_vi: nameVi,
        name_en: nameEn,
        display,
        severity: ((r.severity?.coding || [{}])[0] || {}).display || "",
        onset: r.onsetDateTime || "",
      };
    });
  }

  // ---- 4.7 MedicationAdministration ----
  getMedicationAdministrations() {
    return this._all("MedicationAdministration").map((r) => {
      const dosage = r.dosage || {};
      const doseQ = dosage.dose || {};
      const dose = `${doseQ.value ?? ""} ${doseQ.unit ?? ""}`.trim();
      const route = ((dosage.route?.coding || [{}])[0] || {}).display || "";
      const effective = r.effectiveDateTime || r.effectivePeriod?.start || "";
      return { name: FHIRClient._medName(r), dose, route, effective, status: r.status };
    });
  }

  // ---- 4.8 Procedure ----
  getProcedures() {
    return this._all("Procedure").map((r) => {
      const code = r.code || {};
      let name = code.text;
      if (!name && code.coding?.length) name = code.coding[0].display;
      const performed = r.performedDateTime || r.performedPeriod?.start || "";
      const body = r.bodySite || [];
      const bodySite = body.length ? body[0].display : null;
      return { name: name ?? null, status: r.status, performed, bodySite };
    });
  }

  // ---- 4.9 DiagnosticReport ----
  getDiagnosticReports() {
    return this._all("DiagnosticReport").map((r) => {
      const code = r.code || {};
      let title = code.text;
      if (!title && code.coding?.length) title = code.coding[0].display;
      return { title: title ?? null, status: r.status, date: r.effectiveDateTime || r.issued || "" };
    });
  }

  // ---- consolidate ----
  buildPatientContext() {
    return {
      patient_id: this.patientId,
      patient: this.getPatient(),
      encounter: this.getEncounter(),
      allergies: this.getAllergies(),
      observations: this.getObservations(),
      medications: this.getMedications(),
      conditions: this.getConditions(),
      medication_administrations: this.getMedicationAdministrations(),
      procedures: this.getProcedures(),
      diagnostic_reports: this.getDiagnosticReports(),
      missing_resources: [],
    };
  }
}

// Whole years between `date` and now (matches relativedelta(...).years).
function yearsSince(date) {
  const now = new Date();
  let age = now.getFullYear() - date.getFullYear();
  const m = now.getMonth() - date.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < date.getDate())) age -= 1;
  return age;
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
