#!/usr/bin/env node
/**
 * Clinical Guidelines MCP Server — Verity Health Agent
 *
 * Tools:
 *   guidelines_search  — search PubMed for clinical practice guidelines,
 *                        filtered to practice guideline publication type.
 *                        Returns guidelines from ASCO, ESMO, NCCN, AHA, etc.
 *   health_topic       — MedlinePlus evidence-based health topic summaries.
 *                        Good for condition overviews and patient-facing content.
 *
 * APIs (all free, no key required):
 *   NCBI E-utilities   https://eutils.ncbi.nlm.nih.gov  (set NCBI_API_KEY for higher rate limits)
 *   NLM MedlinePlus    https://wsearch.nlm.nih.gov
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import https from 'https'

const NCBI_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'
const MEDLINEPLUS_BASE = 'https://wsearch.nlm.nih.gov/ws/query'
const API_KEY = process.env.NCBI_API_KEY ?? ''

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

function ncbiUrl(endpoint, params) {
  const p = new URLSearchParams({ retmode: 'json', ...params })
  if (API_KEY) p.set('api_key', API_KEY)
  return `${NCBI_BASE}/${endpoint}?${p}`
}

// ── Tool implementations ───────────────────────────────────────────────────────

async function guidelinesSearch({ condition, topic, organization, max_results = 10, year_from }) {
  const cap = Math.min(max_results, 20)

  // Build PubMed query filtered to practice guidelines
  // "practice guideline[pt]" is the MeSH publication type
  let term = `"practice guideline"[pt]`

  if (condition) term += ` AND "${condition}"[tiab]`
  if (topic) term += ` AND "${topic}"[tiab]`
  if (organization) term += ` AND "${organization}"[ad]`  // affiliation field for org
  if (year_from) term += ` AND ${year_from}:3000[pdat]`

  // Search PubMed
  const searchParams = {
    db: 'pubmed',
    term,
    retmax: String(cap),
    sort: 'date',
    usehistory: 'y',
  }

  const searchData = JSON.parse(await get(ncbiUrl('esearch.fcgi', searchParams)))
  const ids = searchData.esearchresult?.idlist ?? []
  const total = parseInt(searchData.esearchresult?.count ?? '0', 10)

  if (ids.length === 0) {
    return { total: 0, returned: 0, query: term, guidelines: [] }
  }

  // Fetch summaries
  const summaryData = JSON.parse(
    await get(ncbiUrl('esummary.fcgi', { db: 'pubmed', id: ids.join(',') }))
  )

  // Fetch abstracts
  const abstractXml = await get(ncbiUrl('efetch.fcgi', {
    db: 'pubmed',
    id: ids.join(','),
    rettype: 'abstract',
    retmode: 'xml',
  }))

  // Extract abstracts via regex
  const abstracts = {}
  const matches = String(abstractXml).matchAll(
    /<MedlineCitation[^>]*>.*?<PMID[^>]*>(\d+)<\/PMID>.*?(?:<AbstractText[^>]*>(.*?)<\/AbstractText>).*?<\/MedlineCitation>/gs
  )
  for (const m of matches) {
    abstracts[m[1]] = (m[2] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  }

  const guidelines = ids.map(id => {
    const doc = summaryData.result?.[id] ?? {}
    return {
      pmid: id,
      title: doc.title ?? '',
      authors: (doc.authors ?? []).slice(0, 3).map(a => a.name).join(', '),
      journal: doc.fulljournalname ?? doc.source ?? '',
      year: doc.pubdate?.split(' ')[0] ?? '',
      pub_types: doc.pubtype ?? [],
      abstract: abstracts[id] ?? '',
      pubmed_url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
    }
  })

  return {
    total,
    returned: guidelines.length,
    sorted_by: 'date (newest first)',
    query: term,
    note: total > cap
      ? `Showing ${guidelines.length} of ${total} guidelines. Narrow with organization (e.g. "ASCO", "ESMO") or year_from.`
      : undefined,
    guidelines,
  }
}

async function healthTopic({ query, max_results = 5 }) {
  const cap = Math.min(max_results, 10)
  const url = `${MEDLINEPLUS_BASE}?` + new URLSearchParams({
    db: 'healthTopics',
    term: query,
    retmax: String(cap),
  })

  const raw = await get(url)
  if (!raw) return { total: 0, results: [], query }

  // Parse XML response
  const topics = []
  const docMatches = raw.matchAll(/<document[^>]+url="([^"]+)"[^>]*>(.*?)<\/document>/gs)

  // MedlinePlus wraps search terms in HTML spans encoded as XML entities (&lt;span&gt;)
  // Decode entities then strip tags to get plain text
  function stripHtml(s) {
    return s
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  }

  for (const m of docMatches) {
    const url = m[1]
    const body = m[2]

    const titleMatch = body.match(/<content name="title">(.*?)<\/content>/s)
    const summaryMatch = body.match(/<content name="FullSummary">(.*?)<\/content>/s)
    const alsoMatch = body.match(/<content name="altTitle">(.*?)<\/content>/s)

    const title = stripHtml(titleMatch?.[1] ?? '')
    const summary = stripHtml(summaryMatch?.[1] ?? '')
    const also_called = stripHtml(alsoMatch?.[1] ?? '')

    if (title) {
      topics.push({
        title,
        also_called: also_called || undefined,
        summary: summary.slice(0, 800) + (summary.length > 800 ? '...' : ''),
        url,
      })
    }
  }

  return {
    total: topics.length,
    query,
    topics,
  }
}

// ── MCP server ─────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'guidelines', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'guidelines_search',
      description: 'Search for clinical practice guidelines on PubMed. Returns guidelines from major organizations (ASCO, ESMO, NCCN, AHA, ADA, USPSTF, etc.) sorted by most recent. Use this when asked about treatment recommendations, standard of care, screening guidelines, or evidence-based management.',
      inputSchema: {
        type: 'object',
        properties: {
          condition: {
            type: 'string',
            description: 'Disease or condition. E.g. "non-small cell lung cancer", "type 2 diabetes", "hypertension", "breast cancer screening".',
          },
          topic: {
            type: 'string',
            description: 'Specific clinical topic. E.g. "first-line treatment", "adjuvant chemotherapy", "immunotherapy", "screening", "staging". Optional.',
          },
          organization: {
            type: 'string',
            description: 'Issuing organization to filter by. E.g. "ASCO", "ESMO", "NCCN", "AHA", "ADA". Optional.',
          },
          year_from: {
            type: 'number',
            description: 'Only return guidelines from this year onward. E.g. 2020. ONLY set this if the user explicitly specifies a year or date range. Do NOT infer it from words like "current", "recent", or "latest" — omit it and let the results sort by date instead.',
          },
          max_results: {
            type: 'number',
            description: 'Max guidelines to return (default 10, max 20).',
          },
        },
        required: ['condition'],
      },
    },
    {
      name: 'health_topic',
      description: 'Get NLM MedlinePlus evidence-based health topic summaries. Good for condition overviews, patient education content, and general medical information. Complements guidelines_search for broader context.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Health topic to look up. E.g. "lung cancer", "diabetes", "hypertension", "EGFR mutations".',
          },
          max_results: {
            type: 'number',
            description: 'Max topics to return (default 5, max 10).',
          },
        },
        required: ['query'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args } = req.params

  try {
    let result
    if (name === 'guidelines_search') result = await guidelinesSearch(args)
    else if (name === 'health_topic') result = await healthTopic(args)
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
