#!/usr/bin/env node
/**
 * Drug Information MCP Server — Verity Health Agent
 *
 * Tools:
 *   drug_lookup        — FDA label: indications, contraindications, warnings, interactions
 *   drug_adverse_events — top adverse events from FDA FAERS database
 *   drug_recalls       — active FDA drug recalls
 *   drug_rxnorm        — RxNorm concept ID, normalized name, synonyms
 *
 * APIs used (all free, no license required):
 *   OpenFDA            https://api.fda.gov  (set OPENFDA_API_KEY for 1000 req/min vs 240)
 *   NLM RxNorm         https://rxnav.nlm.nih.gov
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import https from 'https'

const FDA_BASE = 'https://api.fda.gov'
const RXNORM_BASE = 'https://rxnav.nlm.nih.gov/REST'
const API_KEY = process.env.OPENFDA_API_KEY ?? ''

// ── HTTP helper ────────────────────────────────────────────────────────────────

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        if (res.statusCode === 404) {
          resolve(null)  // Not found is not an error — caller handles it
        } else if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        } else {
          resolve(data)
        }
      })
    }).on('error', reject)
  })
}

function fdaUrl(endpoint, params) {
  const p = new URLSearchParams(params)
  if (API_KEY) p.set('api_key', API_KEY)
  return `${FDA_BASE}${endpoint}?${p}`
}

function truncate(text, maxLen = 600) {
  if (!text || text.length <= maxLen) return text
  return text.slice(0, maxLen) + '...[truncated]'
}

// ── Tool implementations ───────────────────────────────────────────────────────

async function drugLookup({ drug_name }) {
  // Try brand name first, then generic name
  const searches = [
    `openfda.brand_name:"${drug_name}"`,
    `openfda.generic_name:"${drug_name}"`,
    `openfda.substance_name:"${drug_name}"`,
  ]

  let result = null
  for (const search of searches) {
    const raw = await get(fdaUrl('/drug/label.json', { search, limit: '1' }))
    if (!raw) continue
    const data = JSON.parse(raw)
    if (data.results?.length > 0) {
      result = data.results[0]
      break
    }
  }

  if (!result) {
    return { found: false, drug_name, message: `No FDA label found for "${drug_name}". Try the generic or brand name.` }
  }

  const ofd = result.openfda ?? {}

  return {
    found: true,
    brand_name: ofd.brand_name?.[0] ?? '',
    generic_name: ofd.generic_name?.[0] ?? '',
    manufacturer: ofd.manufacturer_name?.[0] ?? '',
    product_type: ofd.product_type?.[0] ?? '',
    route: ofd.route ?? [],
    rxcui: ofd.rxcui ?? [],
    pharm_class: ofd.pharm_class_epc ?? [],
    indications_and_usage: truncate(result.indications_and_usage?.[0]),
    contraindications: truncate(result.contraindications?.[0]),
    warnings: truncate(result.warnings_and_cautions?.[0] ?? result.warnings?.[0]),
    drug_interactions: truncate(result.drug_interactions?.[0]),
    adverse_reactions: truncate(result.adverse_reactions?.[0]),
    dosage_and_administration: truncate(result.dosage_and_administration?.[0]),
  }
}

async function drugAdverseEvents({ drug_name, limit = 10 }) {
  const cap = Math.min(limit, 20)

  // Count by reaction term for this drug
  const raw = await get(fdaUrl('/drug/event.json', {
    search: `patient.drug.medicinalproduct:"${drug_name.toUpperCase()}"`,
    count: 'patient.reaction.reactionmeddrapt.exact',
    limit: String(cap),
  }))

  if (!raw) {
    return { found: false, drug_name, message: `No FAERS adverse event data found for "${drug_name}".` }
  }

  const data = JSON.parse(raw)
  const reactions = data.results ?? []

  // Get total report count
  const totalRaw = await get(fdaUrl('/drug/event.json', {
    search: `patient.drug.medicinalproduct:"${drug_name.toUpperCase()}"`,
    limit: '1',
  }))
  const total = totalRaw ? (JSON.parse(totalRaw).meta?.results?.total ?? 0) : 0

  return {
    drug_name,
    total_reports: total,
    top_reactions: reactions.map(r => ({ reaction: r.term, reports: r.count })),
    note: 'FAERS reports are voluntarily submitted and may reflect reporting bias. Counts do not imply causality.',
    source: 'FDA Adverse Event Reporting System (FAERS)',
  }
}

async function drugRecalls({ drug_name }) {
  const raw = await get(fdaUrl('/drug/enforcement.json', {
    search: `product_description:"${drug_name}" AND status:Ongoing`,
    limit: '5',
  }))

  if (!raw) {
    return { drug_name, active_recalls: [], message: 'No active recalls found.' }
  }

  const data = JSON.parse(raw)
  const results = data.results ?? []

  return {
    drug_name,
    active_recalls: results.map(r => ({
      recall_number: r.recall_number ?? '',
      recalling_firm: r.recalling_firm ?? '',
      product_description: truncate(r.product_description, 200),
      reason_for_recall: truncate(r.reason_for_recall, 200),
      recall_initiation_date: r.recall_initiation_date ?? '',
      classification: r.classification ?? '',
      status: r.status ?? '',
    })),
  }
}

async function drugRxnorm({ drug_name }) {
  // Resolve RxNorm concept ID
  const raw = await get(`${RXNORM_BASE}/rxcui.json?name=${encodeURIComponent(drug_name)}&search=1`)
  if (!raw) return { found: false, drug_name }

  const data = JSON.parse(raw)
  const rxcuis = data.idGroup?.rxnormId ?? []

  if (rxcuis.length === 0) {
    return { found: false, drug_name, message: `No RxNorm concept found for "${drug_name}".` }
  }

  const rxcui = rxcuis[0]

  // Get properties and all related concepts in parallel
  const [propsRaw, allRelatedRaw] = await Promise.all([
    get(`${RXNORM_BASE}/rxcui/${rxcui}/properties.json`),
    get(`${RXNORM_BASE}/rxcui/${rxcui}/allrelated.json`),
  ])

  const props = propsRaw ? JSON.parse(propsRaw).properties ?? {} : {}
  const allRelated = allRelatedRaw ? JSON.parse(allRelatedRaw).allRelatedGroup ?? {} : {}

  // Collect brand names (BN) and ingredient names (IN) as synonyms
  const synonyms = []
  for (const group of allRelated.conceptGroup ?? []) {
    if (!['BN', 'IN', 'PIN'].includes(group.tty)) continue
    for (const concept of group.conceptProperties ?? []) {
      if (concept.name && concept.name !== props.name) synonyms.push(concept.name)
    }
  }

  return {
    found: true,
    drug_name,
    rxcui,
    name: props.name ?? '',
    synonym: props.synonym ?? '',
    tty: props.tty ?? '',
    synonyms: [...new Set(synonyms)].slice(0, 10),
    rxnorm_url: `https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm=${rxcui}`,
  }
}

// ── MCP server ─────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'drugs', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'drug_lookup',
      description: 'Look up FDA-approved drug label information: indications, contraindications, warnings, drug interactions, and adverse reactions. The tool automatically tries brand name, generic name, and substance name — do NOT retry with alternative names if it returns a result. Call once per drug.',
      inputSchema: {
        type: 'object',
        properties: {
          drug_name: {
            type: 'string',
            description: 'Brand name or generic name of the drug. E.g. "tagrisso", "osimertinib", "warfarin", "metformin".',
          },
        },
        required: ['drug_name'],
      },
    },
    {
      name: 'drug_adverse_events',
      description: 'Get top adverse events reported to FDA for a drug, ranked by report count. Data from FDA Adverse Event Reporting System (FAERS). Useful for understanding real-world safety signals beyond the label.',
      inputSchema: {
        type: 'object',
        properties: {
          drug_name: {
            type: 'string',
            description: 'Generic or brand name of the drug.',
          },
          limit: {
            type: 'number',
            description: 'Number of top reactions to return (default 10, max 20).',
          },
        },
        required: ['drug_name'],
      },
    },
    {
      name: 'drug_recalls',
      description: 'Check for active FDA drug recalls for a given drug. Returns recall reason, classification, and recalling firm.',
      inputSchema: {
        type: 'object',
        properties: {
          drug_name: {
            type: 'string',
            description: 'Drug name to check for active recalls.',
          },
        },
        required: ['drug_name'],
      },
    },
    {
      name: 'drug_rxnorm',
      description: 'Look up a drug\'s RxNorm concept ID, normalized name, and synonyms. Useful for standardizing drug names before searching other systems or checking interactions.',
      inputSchema: {
        type: 'object',
        properties: {
          drug_name: {
            type: 'string',
            description: 'Drug name to normalize via RxNorm.',
          },
        },
        required: ['drug_name'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args } = req.params

  try {
    let result
    if (name === 'drug_lookup') result = await drugLookup(args)
    else if (name === 'drug_adverse_events') result = await drugAdverseEvents(args)
    else if (name === 'drug_recalls') result = await drugRecalls(args)
    else if (name === 'drug_rxnorm') result = await drugRxnorm(args)
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
