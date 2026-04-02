#!/usr/bin/env node
/**
 * MIMIC-IV MCP Server — Verity Health Agent
 *
 * Tools:
 *   mimic_patient        — demographics, diagnoses, medications for a patient
 *   mimic_labs           — recent lab results for a patient/admission
 *   mimic_cohort         — find patients by ICD code or condition keyword
 *   mimic_icu            — ICU stay summary with vitals snapshot
 *
 * Requires:
 *   GCP_PROJECT          — your billing project (e.g. mimic-491221)
 *   Application Default Credentials via `gcloud auth application-default login`
 *
 * Data: physionet-data.mimiciv_3_1_hosp + mimiciv_3_1_icu (MIMIC-IV v3.1)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { BigQuery } from '@google-cloud/bigquery'

const PROJECT = process.env.GCP_PROJECT ?? 'mimic-491221'
const HOSP = 'physionet-data.mimiciv_3_1_hosp'
const ICU  = 'physionet-data.mimiciv_3_1_icu'

const bq = new BigQuery({ projectId: PROJECT })

async function query(sql, params = []) {
  const [rows] = await bq.query({ query: sql, params, useLegacySql: false })
  return rows
}

// ── Tool implementations ───────────────────────────────────────────────────────

async function mimicPatient({ subject_id }) {
  const id = parseInt(subject_id, 10)

  const [demographics, admissions, diagnoses, medications] = await Promise.all([
    // Demographics
    query(`
      SELECT subject_id, gender, anchor_age, anchor_year_group
      FROM \`${HOSP}.patients\`
      WHERE subject_id = @id
    `, { id }),

    // Most recent admission
    query(`
      SELECT hadm_id, admittime, dischtime, admission_type, admission_location,
             discharge_location, race, marital_status, language,
             hospital_expire_flag
      FROM \`${HOSP}.admissions\`
      WHERE subject_id = @id
      ORDER BY admittime DESC LIMIT 3
    `, { id }),

    // Active diagnoses (most recent admission)
    query(`
      SELECT d.icd_code, d.icd_version, i.long_title, d.seq_num
      FROM \`${HOSP}.diagnoses_icd\` d
      JOIN \`${HOSP}.d_icd_diagnoses\` i USING (icd_code, icd_version)
      WHERE d.subject_id = @id
        AND d.hadm_id = (
          SELECT hadm_id FROM \`${HOSP}.admissions\`
          WHERE subject_id = @id ORDER BY admittime DESC LIMIT 1
        )
      ORDER BY d.seq_num
      LIMIT 20
    `, { id }),

    // Current medications (most recent admission)
    query(`
      SELECT drug, formulary_drug_cd, route, dose_val_rx, dose_unit_rx,
             form_val_disp, form_unit_disp, doses_per_24_hrs
      FROM \`${HOSP}.prescriptions\`
      WHERE subject_id = @id
        AND hadm_id = (
          SELECT hadm_id FROM \`${HOSP}.admissions\`
          WHERE subject_id = @id ORDER BY admittime DESC LIMIT 1
        )
      ORDER BY starttime DESC
      LIMIT 30
    `, { id }),
  ])

  if (demographics.length === 0) {
    return { found: false, subject_id: id, message: `No patient found with subject_id ${id}` }
  }

  const pt = demographics[0]
  const adm = admissions[0] ?? null

  return {
    found: true,
    subject_id: id,
    gender: pt.gender,
    age_at_anchor: pt.anchor_age,
    anchor_year_group: pt.anchor_year_group,
    note: 'Age is as of anchor_year_group (dates shifted for de-identification)',
    most_recent_admission: adm ? {
      hadm_id: adm.hadm_id,
      admit_date: adm.admittime?.value?.slice(0, 10),
      discharge_date: adm.dischtime?.value?.slice(0, 10),
      admission_type: adm.admission_type,
      discharge_location: adm.discharge_location,
      race: adm.race,
      in_hospital_death: adm.hospital_expire_flag === 1,
    } : null,
    prior_admissions: admissions.length,
    diagnoses: diagnoses.map(d => ({
      seq: d.seq_num,
      icd_code: d.icd_code,
      icd_version: d.icd_version,
      description: d.long_title,
    })),
    medications: medications.map(m => ({
      drug: m.drug,
      route: m.route,
      dose: `${m.dose_val_rx ?? ''} ${m.dose_unit_rx ?? ''}`.trim(),
      frequency: m.doses_per_24_hrs ? `${m.doses_per_24_hrs}x/day` : undefined,
    })),
  }
}

async function mimicLabs({ subject_id, hadm_id, limit = 20 }) {
  const id = parseInt(subject_id, 10)
  const cap = Math.min(limit, 50)

  let sql = `
    SELECT l.itemid, d.label, d.fluid, d.category,
           l.value, l.valuenum, l.valueuom, l.flag,
           l.charttime
    FROM \`${HOSP}.labevents\` l
    JOIN \`${HOSP}.d_labitems\` d USING (itemid)
    WHERE l.subject_id = @id
  `
  const params = { id }

  if (hadm_id) {
    sql += ` AND l.hadm_id = @hadm_id`
    params.hadm_id = parseInt(hadm_id, 10)
  } else {
    // Most recent admission
    sql += ` AND l.hadm_id = (
      SELECT hadm_id FROM \`${HOSP}.admissions\`
      WHERE subject_id = @id ORDER BY admittime DESC LIMIT 1
    )`
  }

  sql += ` ORDER BY l.charttime DESC LIMIT @cap`
  params.cap = cap

  const rows = await query(sql, params)

  return {
    subject_id: id,
    hadm_id: hadm_id ?? 'most recent',
    returned: rows.length,
    labs: rows.map(r => ({
      label: r.label,
      category: r.category,
      fluid: r.fluid,
      value: r.value,
      numeric: r.valuenum,
      unit: r.valueuom,
      flag: r.flag ?? 'normal',
      time: r.charttime?.value?.slice(0, 16),
    })),
  }
}

// Common lay terms → MIMIC ICD-9 medical terminology
const SYNONYMS = {
  'lung cancer': 'malignant lung',
  'cancer': 'malignant neoplasm',
  'heart attack': 'myocardial infarction',
  'stroke': 'cerebral infarction',
  'kidney failure': 'renal failure',
  'kidney disease': 'chronic kidney',
  'copd': 'chronic obstructive',
  'blood clot': 'thrombosis',
  'blood pressure': 'hypertension',
  'diabetes': 'diabetes',
  'liver failure': 'hepatic failure',
  'liver disease': 'hepatic',
  'heart failure': 'heart failure',
  'afib': 'atrial fibrillation',
  'a-fib': 'atrial fibrillation',
}

async function mimicCohort({ icd_code, keyword, limit = 10 }) {
  const cap = Math.min(limit, 50)

  // Translate lay terms to MIMIC medical terminology
  if (keyword) {
    const lower = keyword.toLowerCase()
    for (const [lay, medical] of Object.entries(SYNONYMS)) {
      if (lower.includes(lay)) {
        keyword = lower.replace(lay, medical)
        break
      }
    }
  }

  let sql, params

  if (icd_code) {
    sql = `
      SELECT p.subject_id, p.gender, p.anchor_age,
             MAX(a.admittime) AS last_admit
      FROM \`${HOSP}.diagnoses_icd\` d
      JOIN \`${HOSP}.patients\` p USING (subject_id)
      JOIN \`${HOSP}.admissions\` a USING (subject_id, hadm_id)
      WHERE d.icd_code = @icd_code
      GROUP BY 1,2,3
      ORDER BY last_admit DESC
      LIMIT ${cap}
    `
    params = { icd_code }
  } else if (keyword) {
    // Split multi-word keywords into separate AND LIKE conditions
    const words = keyword.toLowerCase().split(/\s+/).filter(Boolean)
    const likeClauses = words.map((_, i) => `LOWER(i.long_title) LIKE @kw${i}`).join(' AND ')
    params = {}
    words.forEach((w, i) => { params[`kw${i}`] = `%${w}%` })

    sql = `
      SELECT p.subject_id, p.gender, p.anchor_age,
             MAX(a.admittime) AS last_admit,
             STRING_AGG(DISTINCT i.long_title, '; ' LIMIT 3) AS top_diagnoses
      FROM \`${HOSP}.diagnoses_icd\` d
      JOIN \`${HOSP}.patients\` p USING (subject_id)
      JOIN \`${HOSP}.admissions\` a USING (subject_id, hadm_id)
      JOIN \`${HOSP}.d_icd_diagnoses\` i USING (icd_code, icd_version)
      WHERE ${likeClauses}
      GROUP BY 1,2,3
      ORDER BY last_admit DESC
      LIMIT ${cap}
    `
  } else {
    return { error: 'Provide either icd_code or keyword' }
  }

  const rows = await query(sql, params)
  return {
    query: icd_code ?? keyword,
    returned: rows.length,
    patients: rows.map(r => ({
      subject_id: r.subject_id,
      gender: r.gender,
      age: r.anchor_age,
      top_diagnoses: r.top_diagnoses,
      last_admit: r.last_admit?.value?.slice(0, 10),
    })),
  }
}

async function mimicIcu({ subject_id, stay_id }) {
  const id = parseInt(subject_id, 10)

  const stays = await query(`
    SELECT stay_id, first_careunit, last_careunit,
           intime, outtime,
           los
    FROM \`${ICU}.icustays\`
    WHERE subject_id = @id
    ORDER BY intime DESC
    LIMIT 3
  `, { id })

  if (stays.length === 0) {
    return { found: false, subject_id: id, message: 'No ICU stays found.' }
  }

  const target_stay = stay_id
    ? stays.find(s => s.stay_id === parseInt(stay_id, 10)) ?? stays[0]
    : stays[0]

  // Key vitals from chartevents (HR, BP, SpO2, temp, RR, GCS)
  const VITAL_ITEMS = [
    220045, // Heart Rate
    220050, // Arterial BP Systolic
    220051, // Arterial BP Diastolic
    220052, // Arterial BP Mean
    220210, // Respiratory Rate
    223762, // Temperature Celsius
    220277, // SpO2
    220739, // GCS Eye Opening
    223900, // GCS Verbal
    223901, // GCS Motor
  ]

  const vitals = await query(`
    SELECT c.itemid, d.label, c.value, c.valuenum, c.valueuom, c.charttime
    FROM \`${ICU}.chartevents\` c
    JOIN \`${ICU}.d_items\` d USING (itemid)
    WHERE c.stay_id = @stay_id
      AND c.itemid IN UNNEST(@items)
      AND c.warning = 0
    ORDER BY c.charttime DESC
    LIMIT 30
  `, { stay_id: target_stay.stay_id, items: VITAL_ITEMS })

  // Latest value per vital
  const latestVitals = {}
  for (const v of vitals) {
    if (!latestVitals[v.label]) {
      latestVitals[v.label] = {
        value: v.value,
        numeric: v.valuenum,
        unit: v.valueuom,
        time: v.charttime?.value?.slice(0, 16),
      }
    }
  }

  return {
    found: true,
    subject_id: id,
    icu_stays: stays.map(s => ({
      stay_id: s.stay_id,
      unit: s.last_careunit,
      admit: s.intime?.value?.slice(0, 10),
      discharge: s.outtime?.value?.slice(0, 10),
      los_days: s.los ? parseFloat(s.los).toFixed(1) : null,
    })),
    current_stay: {
      stay_id: target_stay.stay_id,
      unit: target_stay.last_careunit,
      los_days: target_stay.los ? parseFloat(target_stay.los).toFixed(1) : null,
    },
    latest_vitals: latestVitals,
  }
}

// ── MCP server ─────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'mimic', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'mimic_cohort',
      description: 'ALWAYS call this first to find MIMIC-IV subject_ids before calling any other mimic tool. Do NOT guess or invent subject_ids. Search by diagnosis keyword (use medical terminology: "pneumonia" not "lung infection", "neoplasm" not "cancer") or exact ICD code.',
      inputSchema: {
        type: 'object',
        properties: {
          icd_code: { type: 'string', description: 'Exact ICD-9 or ICD-10 code. E.g. "J159" for unspecified bacterial pneumonia, "4019" for hypertension.' },
          keyword: { type: 'string', description: 'Diagnosis keyword. Common lay terms are auto-translated (e.g. "lung cancer" → "malignant lung", "heart attack" → "myocardial infarction"). Use 1-2 words.' },
          limit: { type: 'number', description: 'Max patients to return (default 10, max 50).' },
        },
      },
    },
    {
      name: 'mimic_patient',
      description: 'Look up a MIMIC-IV patient by subject_id. Returns demographics, most recent admission summary, diagnoses (ICD codes), and medications. Requires a real subject_id from mimic_cohort — do not guess IDs.',
      inputSchema: {
        type: 'object',
        properties: {
          subject_id: { type: 'number', description: 'MIMIC-IV subject_id from mimic_cohort results.' },
        },
        required: ['subject_id'],
      },
    },
    {
      name: 'mimic_labs',
      description: 'Get recent lab results for a MIMIC-IV patient. Returns lab name, value, unit, and normal/abnormal flag.',
      inputSchema: {
        type: 'object',
        properties: {
          subject_id: { type: 'number', description: 'MIMIC-IV subject_id.' },
          hadm_id: { type: 'number', description: 'Specific hospital admission ID. Defaults to most recent admission.' },
          limit: { type: 'number', description: 'Number of results (default 20, max 50).' },
        },
        required: ['subject_id'],
      },
    },
    {
      name: 'mimic_icu',
      description: 'Get ICU stay summary for a MIMIC-IV patient, including care unit, length of stay, and latest vital signs (HR, BP, SpO2, temperature, GCS).',
      inputSchema: {
        type: 'object',
        properties: {
          subject_id: { type: 'number', description: 'MIMIC-IV subject_id.' },
          stay_id: { type: 'number', description: 'Specific ICU stay ID. Defaults to most recent stay.' },
        },
        required: ['subject_id'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args } = req.params
  try {
    let result
    if (name === 'mimic_patient') result = await mimicPatient(args)
    else if (name === 'mimic_labs') result = await mimicLabs(args)
    else if (name === 'mimic_cohort') result = await mimicCohort(args)
    else if (name === 'mimic_icu') result = await mimicIcu(args)
    else throw new Error(`Unknown tool: ${name}`)

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    }
  }
})

// ── Start ──────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
