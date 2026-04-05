#!/usr/bin/env node
/**
 * Patient Record MCP Server — Verity Health Agent
 *
 * Tools:
 *   patient_list          — list all saved patient records
 *   patient_load          — load a patient record by ID
 *   patient_save          — create a new patient record
 *   patient_update        — update fields of an existing record
 *   patient_generate_id   — generate a unique ID for a new manual patient
 *
 * Storage: ~/.healthagent/patients/<id>.json
 *
 * Schema versioning
 * -----------------
 * Each record carries a `schema_version` field so the server can migrate
 * old records forward on load without breaking existing files.
 *
 *   v0  (legacy)  — original flat schema: demographics, diagnoses, medications,
 *                   labs, icu, raw_text. No schema_version field.
 *   v1  (current) — adds schema_version, fhir_reference, allergies, vitals,
 *                   procedures, social_history; adds `status` to diagnoses and
 *                   medications; adds `onset_date` to diagnoses.
 *
 * FHIR alignment
 * --------------
 * This schema is loosely aligned with the International Patient Summary (IPS)
 * FHIR Implementation Guide (http://hl7.org/fhir/uv/ips/) R4.
 * It is NOT a conformant FHIR resource — it is a simplified flat JSON
 * optimised for LLM consumption. The fhir_reference field documents the
 * intended mapping for future EHR integration or export.
 *
 * Field → IPS FHIR resource mapping:
 *   demographics   → Patient (R4)
 *   diagnoses      → Condition (R4) — clinical-status, onset[x]
 *   medications    → MedicationStatement (R4) — status
 *   allergies      → AllergyIntolerance (R4)
 *   labs           → Observation (R4) + DiagnosticReport (R4)
 *   vitals         → Observation (R4) — category: vital-signs
 *   procedures     → Procedure (R4)
 *   social_history → Observation (R4) — category: social-history
 *   icu            → Encounter (R4) — class: IMP (inpatient)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFile, writeFile, readdir, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const PATIENTS_DIR = join(homedir(), '.healthagent', 'patients')
const CURRENT_SCHEMA_VERSION = 1

const FHIR_REFERENCE = {
  ig: 'http://hl7.org/fhir/uv/ips/',
  ig_version: 'STU2 (2024)',
  fhir_version: 'R4 (4.0.1)',
  note: 'Simplified flat JSON for LLM consumption. Not a conformant FHIR resource.',
}

async function ensureDir() {
  await mkdir(PATIENTS_DIR, { recursive: true })
}

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

/**
 * Migrate a record from any older schema version to CURRENT_SCHEMA_VERSION.
 * Safe to call on already-current records (no-op).
 * Mutates the record in place and returns it.
 */
function migrateRecord(record) {
  const v = record.schema_version ?? 0

  if (v < 1) {
    // v0 → v1: add new top-level sections; add status/onset_date to existing items
    record.schema_version = 1
    record.fhir_reference = FHIR_REFERENCE

    // Backfill status on diagnoses (v0 had none)
    if (Array.isArray(record.diagnoses)) {
      record.diagnoses = record.diagnoses.map(d => ({
        status: 'active',           // safe default — unknown is worse than active
        onset_date: null,
        ...d,
      }))
    }

    // Backfill status on medications (v0 had none)
    if (Array.isArray(record.medications)) {
      record.medications = record.medications.map(m => ({
        status: 'active',           // safe default
        start_date: null,
        end_date: null,
        ...m,
      }))
    }

    // Add missing top-level sections
    record.allergies      = record.allergies      ?? []
    record.vitals         = record.vitals         ?? []
    record.procedures     = record.procedures     ?? []
    record.social_history = record.social_history ?? {}
  }

  return record
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function patientList() {
  await ensureDir()
  let files = []
  try {
    files = await readdir(PATIENTS_DIR)
  } catch {
    return { count: 0, patients: [] }
  }

  const patients = []
  for (const file of files.filter(f => f.endsWith('.json'))) {
    try {
      const content = await readFile(join(PATIENTS_DIR, file), 'utf8')
      const r = migrateRecord(JSON.parse(content))
      patients.push({
        id: r.id,
        schema_version: r.schema_version,
        source: r.source,
        created_at: r.created_at,
        updated_at: r.updated_at,
        demographics: r.demographics ?? {},
        primary_diagnosis: r.diagnoses?.find(d => d.status === 'active')?.description
          ?? r.diagnoses?.[0]?.description
          ?? 'Unknown',
        active_medications: r.medications?.filter(m => m.status === 'active').length ?? 0,
        allergies: r.allergies?.length ?? 0,
      })
    } catch {
      // skip malformed files
    }
  }

  patients.sort((a, b) => b.updated_at?.localeCompare(a.updated_at ?? '') ?? 0)
  return { count: patients.length, patients }
}

async function patientLoad({ id }) {
  await ensureDir()
  const filePath = join(PATIENTS_DIR, `${id}.json`)

  if (!existsSync(filePath)) {
    const { patients } = await patientList()
    return {
      found: false,
      id,
      message: `No patient record found with ID "${id}".`,
      available_ids: patients.map(p => p.id),
    }
  }

  const content = await readFile(filePath, 'utf8')
  const record = migrateRecord(JSON.parse(content))

  // Persist migration upgrade silently so the file stays current
  if ((record.schema_version ?? 0) > (JSON.parse(content).schema_version ?? 0)) {
    await writeFile(filePath, JSON.stringify(record, null, 2), 'utf8')
  }

  return { found: true, record }
}

async function patientSave({
  id, source, demographics,
  diagnoses, medications, allergies,
  labs, vitals, procedures, social_history,
  icu, raw_text,
}) {
  await ensureDir()
  const filePath = join(PATIENTS_DIR, `${id}.json`)

  if (existsSync(filePath)) {
    return { saved: false, id, message: `Patient "${id}" already exists. Use patient_update to modify it.` }
  }

  // Reject hollow saves: if raw_text is provided, at least one structured field must be populated
  const hasStructuredData =
    (demographics && Object.keys(demographics).length > 0) ||
    (diagnoses && diagnoses.length > 0) ||
    (medications && medications.length > 0) ||
    (labs && labs.length > 0)

  if (raw_text && !hasStructuredData) {
    return {
      saved: false,
      id,
      message:
        'Cannot save: raw_text was provided but demographics, diagnoses, medications, and labs are all empty. ' +
        'You must extract structured data from the text and pass it as arguments before calling patient_save.',
    }
  }

  const now = new Date().toISOString()
  const record = {
    schema_version: CURRENT_SCHEMA_VERSION,
    fhir_reference: FHIR_REFERENCE,
    id,
    source: source ?? 'manual',
    created_at: now,
    updated_at: now,
    demographics: demographics ?? {},
    diagnoses: (diagnoses ?? []).map(d => ({
      status: 'active',
      onset_date: null,
      ...d,
    })),
    medications: (medications ?? []).map(m => ({
      status: 'active',
      start_date: null,
      end_date: null,
      ...m,
    })),
    allergies: allergies ?? [],
    labs: labs ?? [],
    vitals: vitals ?? [],
    procedures: procedures ?? [],
    social_history: social_history ?? {},
    icu: icu ?? null,
    raw_text: raw_text ?? null,
  }

  await writeFile(filePath, JSON.stringify(record, null, 2), 'utf8')
  return { saved: true, id, schema_version: CURRENT_SCHEMA_VERSION, path: filePath }
}

async function patientUpdate({
  id, demographics, diagnoses, medications, allergies,
  labs, vitals, procedures, social_history, icu,
}) {
  await ensureDir()
  const filePath = join(PATIENTS_DIR, `${id}.json`)

  if (!existsSync(filePath)) {
    return { found: false, id, message: `No patient record found with ID "${id}".` }
  }

  const content = await readFile(filePath, 'utf8')
  const record = migrateRecord(JSON.parse(content))

  if (demographics)    record.demographics    = { ...record.demographics, ...demographics }
  if (diagnoses)       record.diagnoses       = diagnoses
  if (medications)     record.medications     = medications
  if (allergies)       record.allergies       = allergies
  if (labs)            record.labs            = labs
  if (vitals)          record.vitals          = vitals
  if (procedures)      record.procedures      = procedures
  if (social_history)  record.social_history  = { ...record.social_history, ...social_history }
  if (icu)             record.icu             = icu
  record.updated_at = new Date().toISOString()

  await writeFile(filePath, JSON.stringify(record, null, 2), 'utf8')
  return { updated: true, id, schema_version: record.schema_version, updated_at: record.updated_at }
}

async function patientGenerateId() {
  await ensureDir()
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')

  let files = []
  try {
    files = await readdir(PATIENTS_DIR)
  } catch {
    files = []
  }

  const count = files.filter(f => f.startsWith(`manual_${today}`)).length
  const seq = String(count + 1).padStart(3, '0')
  return { id: `manual_${today}_${seq}` }
}

// ── MCP server ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'patients', version: '0.2.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'patient_list',
      description: 'List all saved patient records in ~/.healthagent/patients/. Returns ID, schema_version, demographics summary, primary active diagnosis, active medication count, and allergy count for each.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'patient_load',
      description: 'Load a saved patient record by ID. Returns the full structured record including allergies, vitals, procedures, and social history. If not found, lists available IDs.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Patient ID, e.g. "mimic_10032" or "manual_20260402_001".' },
        },
        required: ['id'],
      },
    },
    {
      name: 'patient_save',
      description: 'Save a new patient record. Schema v1 — aligned with IPS FHIR R4. Fields: demographics, diagnoses (with status + onset_date), medications (with status + dates), allergies, labs, vitals, procedures, social_history, icu, raw_text.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Patient ID.' },
          source: { type: 'string', description: '"mimic" or "manual".' },
          demographics: {
            type: 'object',
            description: 'Age, gender, dob, race, language, etc. Maps to FHIR Patient (R4).',
          },
          diagnoses: {
            type: 'array',
            items: { type: 'object' },
            description: 'List of { icd_code, icd_version, description, status ("active"|"resolved"|"chronic"), onset_date (ISO date or null), seq }. Maps to FHIR Condition (R4).',
          },
          medications: {
            type: 'array',
            items: { type: 'object' },
            description: 'List of { drug, dose, route, frequency, status ("active"|"discontinued"|"on-hold"), start_date, end_date, indication }. Maps to FHIR MedicationStatement (R4).',
          },
          allergies: {
            type: 'array',
            items: { type: 'object' },
            description: 'List of { substance, type ("medication"|"food"|"environment"), severity ("mild"|"moderate"|"severe"), reaction, onset_date }. Maps to FHIR AllergyIntolerance (R4).',
          },
          labs: {
            type: 'array',
            items: { type: 'object' },
            description: 'List of { label, value, unit, reference_range, flag ("normal"|"low"|"high"|"critical"), time }. Maps to FHIR Observation (R4).',
          },
          vitals: {
            type: 'array',
            items: { type: 'object' },
            description: 'List of { type ("bp"|"hr"|"temp"|"rr"|"spo2"|"weight"|"height"|"bmi"), value, unit, time }. Maps to FHIR Observation category:vital-signs (R4).',
          },
          procedures: {
            type: 'array',
            items: { type: 'object' },
            description: 'List of { description, code, code_system ("CPT"|"SNOMED"|"ICD-10-PCS"), date, status ("completed"|"in-progress") }. Maps to FHIR Procedure (R4).',
          },
          social_history: {
            type: 'object',
            description: '{ smoking_status, alcohol_use, occupation, living_situation, exercise }. Maps to FHIR Observation category:social-history (R4).',
          },
          icu: {
            type: 'object',
            description: 'ICU stay summary if available. Maps to FHIR Encounter (R4) class:IMP.',
          },
          raw_text: {
            type: 'string',
            description: 'Original free text input if source is manual.',
          },
        },
        required: ['id'],
      },
    },
    {
      name: 'patient_update',
      description: 'Update fields of an existing patient record. Only provided fields are changed. Automatically migrates older schema versions. demographics and social_history are merged (patch); all other arrays are replaced.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Patient ID to update.' },
          demographics: { type: 'object' },
          diagnoses: { type: 'array', items: { type: 'object' } },
          medications: { type: 'array', items: { type: 'object' } },
          allergies: { type: 'array', items: { type: 'object' } },
          labs: { type: 'array', items: { type: 'object' } },
          vitals: { type: 'array', items: { type: 'object' } },
          procedures: { type: 'array', items: { type: 'object' } },
          social_history: { type: 'object' },
          icu: { type: 'object' },
        },
        required: ['id'],
      },
    },
    {
      name: 'patient_generate_id',
      description: 'Generate a unique sequential ID for a new manual patient entry. Format: manual_YYYYMMDD_NNN.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args } = req.params
  try {
    let result
    if      (name === 'patient_list')        result = await patientList()
    else if (name === 'patient_load')        result = await patientLoad(args)
    else if (name === 'patient_save')        result = await patientSave(args)
    else if (name === 'patient_update')      result = await patientUpdate(args)
    else if (name === 'patient_generate_id') result = await patientGenerateId()
    else throw new Error(`Unknown tool: ${name}`)

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
