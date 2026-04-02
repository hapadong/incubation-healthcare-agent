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
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFile, writeFile, readdir, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const PATIENTS_DIR = join(homedir(), '.healthagent', 'patients')

async function ensureDir() {
  await mkdir(PATIENTS_DIR, { recursive: true })
}

// ── Tool implementations ────────────────────────────────────────────────────

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
      const r = JSON.parse(content)
      patients.push({
        id: r.id,
        source: r.source,
        created_at: r.created_at,
        updated_at: r.updated_at,
        demographics: r.demographics ?? {},
        primary_diagnosis: r.diagnoses?.[0]?.description ?? 'Unknown',
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
  return { found: true, record: JSON.parse(content) }
}

async function patientSave({ id, source, demographics, diagnoses, medications, labs, icu, raw_text }) {
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
      message: 'Cannot save: raw_text was provided but demographics, diagnoses, medications, and labs are all empty. ' +
        'You must extract structured data from the text and pass it as arguments (demographics, diagnoses, medications) before calling patient_save.',
    }
  }

  const now = new Date().toISOString()
  const record = {
    id,
    source: source ?? 'manual',
    created_at: now,
    updated_at: now,
    demographics: demographics ?? {},
    diagnoses: diagnoses ?? [],
    medications: medications ?? [],
    labs: labs ?? [],
    icu: icu ?? null,
    raw_text: raw_text ?? null,
  }

  await writeFile(filePath, JSON.stringify(record, null, 2), 'utf8')
  return { saved: true, id, path: filePath }
}

async function patientUpdate({ id, demographics, diagnoses, medications, labs, icu }) {
  await ensureDir()
  const filePath = join(PATIENTS_DIR, `${id}.json`)

  if (!existsSync(filePath)) {
    return { found: false, id, message: `No patient record found with ID "${id}".` }
  }

  const content = await readFile(filePath, 'utf8')
  const record = JSON.parse(content)

  if (demographics) record.demographics = { ...record.demographics, ...demographics }
  if (diagnoses)   record.diagnoses = diagnoses
  if (medications) record.medications = medications
  if (labs)        record.labs = labs
  if (icu)         record.icu = icu
  record.updated_at = new Date().toISOString()

  await writeFile(filePath, JSON.stringify(record, null, 2), 'utf8')
  return { updated: true, id, updated_at: record.updated_at }
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
  { name: 'patients', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'patient_list',
      description: 'List all saved patient records in ~/.healthagent/patients/. Returns ID, source, demographics summary, and primary diagnosis for each.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'patient_load',
      description: 'Load a saved patient record by ID. Returns the full structured record. If not found, lists available IDs.',
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
      description: 'Save a new patient record to disk. Use for first-time saves only — use patient_update to modify existing records.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Patient ID.' },
          source: { type: 'string', description: '"mimic" or "manual".' },
          demographics: { type: 'object', description: 'Age, gender, anchor_year_group, race, etc.' },
          diagnoses: { type: 'array', items: { type: 'object' }, description: 'List of { icd_code, icd_version, description, seq }.' },
          medications: { type: 'array', items: { type: 'object' }, description: 'List of { drug, dose, route, frequency }.' },
          labs: { type: 'array', items: { type: 'object' }, description: 'List of { label, value, unit, flag, time }.' },
          icu: { type: 'object', description: 'ICU stay summary if available.' },
          raw_text: { type: 'string', description: 'Original free text input if source is manual.' },
        },
        required: ['id'],
      },
    },
    {
      name: 'patient_update',
      description: 'Update fields of an existing patient record. Only updates the fields provided — other fields are unchanged.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Patient ID to update.' },
          demographics: { type: 'object' },
          diagnoses: { type: 'array', items: { type: 'object' } },
          medications: { type: 'array', items: { type: 'object' } },
          labs: { type: 'array', items: { type: 'object' } },
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
