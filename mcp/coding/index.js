#!/usr/bin/env node
/**
 * Clinical Coding MCP Server — Verity Health Agent
 *
 * Tools:
 *   icd10_search  — find ICD-10-CM codes by description keyword or code prefix
 *   icd10_lookup  — get all codes under an ICD-10-CM category/prefix
 *   loinc_search  — find LOINC codes for lab tests and clinical observations
 *
 * APIs (all free, no key required):
 *   NLM Clinical Tables  https://clinicaltables.nlm.nih.gov
 *
 * Note: ICD-10 search uses medical terminology (e.g. "malignant neoplasm" not
 * "cancer", "myocardial infarction" not "heart attack"). The tool description
 * instructs the model to translate lay terms before searching.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import https from 'https'

const NLM_BASE = 'https://clinicaltables.nlm.nih.gov/api'

// ── HTTP helper ────────────────────────────────────────────────────────────────

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        if (res.statusCode === 404) {
          resolve(null)
        } else if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        } else {
          resolve(data)
        }
      })
    }).on('error', reject)
  })
}

// ── Tool implementations ───────────────────────────────────────────────────────

/**
 * ICD-10-CM search via NLM Clinical Tables.
 * The API matches against both code prefixes and description text.
 * Works best with ICD-10 terminology — the model should translate
 * lay terms (cancer → malignant neoplasm, heart attack → myocardial infarction).
 */
async function icd10Search({ terms, max_results = 10 }) {
  const cap = Math.min(max_results, 20)
  const url = `${NLM_BASE}/icd10cm/v3/search?` + new URLSearchParams({
    terms,
    maxList: String(cap),
    sf: 'code,name',
    df: 'code,name',
  })

  const raw = await get(url)
  if (!raw) return { total: 0, results: [], terms }

  const data = JSON.parse(raw)
  // Response: [total, [codes], null, [[code, name], ...]]
  const total = data[0] ?? 0
  const items = data[3] ?? []

  return {
    total,
    returned: items.length,
    terms,
    results: items.map(([code, name]) => ({ code, name })),
    note: total > cap
      ? `Showing ${items.length} of ${total}. Use a more specific term or a code prefix (e.g. "C34" for lung cancers).`
      : undefined,
  }
}

/**
 * LOINC search via NLM Clinical Tables.
 * Returns LOINC codes with component, system, scale type, and full name.
 */
async function loincSearch({ terms, max_results = 10, category }) {
  const cap = Math.min(max_results, 20)

  const params = {
    terms,
    maxList: String(cap),
    df: 'LOINC_NUM,LONG_COMMON_NAME,COMPONENT,SYSTEM,SCALE_TYP,CLASS',
    sf: 'LOINC_NUM,LONG_COMMON_NAME,COMPONENT',
  }

  // Filter by category if provided (LAB, CLINICAL, SURVEY, etc.)
  if (category) params.q = `CLASS:${category.toUpperCase()}`

  const url = `${NLM_BASE}/loinc_items/v3/search?` + new URLSearchParams(params)

  const raw = await get(url)
  if (!raw) return { total: 0, results: [], terms }

  const data = JSON.parse(raw)
  const total = data[0] ?? 0
  const items = data[3] ?? []

  return {
    total,
    returned: items.length,
    terms,
    results: items.map(([loinc_num, long_name, component, system, scale, loinc_class]) => ({
      loinc_num,
      long_name,
      component,
      system: system || undefined,
      scale: scale || undefined,
      class: loinc_class || undefined,
    })),
    note: total > cap
      ? `Showing ${items.length} of ${total}. Use more specific terms or filter by category (LAB, CLINICAL, SURVEY).`
      : undefined,
  }
}

// ── MCP server ─────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'coding', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'icd10_search',
      description: 'Search ICD-10-CM codes by description keyword or code prefix. IMPORTANT: ICD-10 uses clinical terminology — translate lay terms before searching: "cancer" → "malignant neoplasm", "heart attack" → "myocardial infarction", "stroke" → "cerebral infarction", "broken bone" → "fracture". For a category, search by code prefix: "C34" returns all lung cancer codes, "E11" returns all type 2 diabetes codes.',
      inputSchema: {
        type: 'object',
        properties: {
          terms: {
            type: 'string',
            description: 'ICD-10 description keyword(s) or code prefix. Use clinical terms. Examples: "malignant neoplasm lung", "myocardial infarction", "C34", "E11.9", "type 2 diabetes".',
          },
          max_results: {
            type: 'number',
            description: 'Max results to return (default 10, max 20).',
          },
        },
        required: ['terms'],
      },
    },
    {
      name: 'loinc_search',
      description: 'Search LOINC codes for laboratory tests, clinical observations, and survey instruments. Use for finding standard codes for lab orders, vital signs, clinical assessments.',
      inputSchema: {
        type: 'object',
        properties: {
          terms: {
            type: 'string',
            description: 'Lab test or observation name. Examples: "hemoglobin a1c", "creatinine", "blood pressure", "troponin", "EGFR mutation".',
          },
          max_results: {
            type: 'number',
            description: 'Max results to return (default 10, max 20).',
          },
          category: {
            type: 'string',
            description: 'Optional category filter: LAB, CLINICAL, SURVEY, DOCUMENT. Narrows to a specific type.',
          },
        },
        required: ['terms'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args } = req.params

  try {
    let result
    if (name === 'icd10_search') result = await icd10Search(args)
    else if (name === 'loinc_search') result = await loincSearch(args)
    else throw new Error(`Unknown tool: ${name}`)

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    }
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
