#!/usr/bin/env node
/**
 * PubMed MCP Server — Verity Health Agent
 *
 * Tools:
 *   pubmed_search  — search PubMed, return article list with abstracts
 *   pubmed_fetch   — fetch full details for a single article by PMID
 *   pubmed_related — find related articles for a given PMID
 *
 * Uses NCBI E-utilities API (free, public).
 * Set NCBI_API_KEY env var for 100 req/s (vs 10 req/s without key).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import https from 'https'

const NCBI_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'
const API_KEY = process.env.NCBI_API_KEY ?? ''

// ── HTTP helper ────────────────────────────────────────────────────────────────

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`NCBI returned HTTP ${res.statusCode} for ${url}`))
        } else {
          resolve(data)
        }
      })
    }).on('error', reject)
  })
}

function apiUrl(endpoint, params) {
  const p = new URLSearchParams({ retmode: 'json', ...params })
  if (API_KEY) p.set('api_key', API_KEY)
  return `${NCBI_BASE}/${endpoint}?${p}`
}

// ── Tool implementations ───────────────────────────────────────────────────────

async function pubmedSearch({ query, max_results = 10, date_range }) {
  const params = {
    db: 'pubmed',
    term: query,
    retmax: String(Math.min(max_results, 20)),
    usehistory: 'y',
  }
  if (date_range) {
    // date_range format: "2020:2025" or "2020/01/01:2025/12/31"
    params.datetype = 'pdat'
    const [mindate, maxdate] = date_range.split(':')
    if (mindate) params.mindate = mindate.trim()
    if (maxdate) params.maxdate = maxdate.trim()
  }

  const searchData = JSON.parse(await get(apiUrl('esearch.fcgi', params)))
  const ids = searchData.esearchresult?.idlist ?? []
  if (ids.length === 0) {
    return { articles: [], total: 0, query }
  }

  // Fetch summaries for all returned IDs in one call
  const summaryData = JSON.parse(
    await get(apiUrl('esummary.fcgi', { db: 'pubmed', id: ids.join(',') }))
  )

  const articles = ids.map(id => {
    const doc = summaryData.result?.[id]
    if (!doc) return { pmid: id }
    return {
      pmid: id,
      title: doc.title ?? '',
      authors: (doc.authors ?? []).slice(0, 6).map(a => a.name).join(', '),
      journal: doc.fulljournalname ?? doc.source ?? '',
      year: doc.pubdate?.split(' ')[0] ?? '',
      doi: doc.elocationid ?? '',
      pub_types: doc.pubtype ?? [],
    }
  })

  // Fetch abstracts separately (esummary doesn't include them)
  // efetch returns XML here — do NOT JSON.parse it
  const abstractData = await get(apiUrl('efetch.fcgi', {
    db: 'pubmed',
    id: ids.join(','),
    rettype: 'abstract',
    retmode: 'xml',
  }))

  // Parse abstracts from XML — simple regex extraction to avoid xml2js dependency
  const abstracts = {}
  const articleMatches = String(abstractData).matchAll(
    /<MedlineCitation[^>]*>.*?<PMID[^>]*>(\d+)<\/PMID>.*?(?:<AbstractText[^>]*>(.*?)<\/AbstractText>|<Abstract>(.*?)<\/Abstract>).*?<\/MedlineCitation>/gs
  )
  for (const m of articleMatches) {
    abstracts[m[1]] = (m[2] ?? m[3] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  }

  for (const article of articles) {
    article.abstract = abstracts[article.pmid] ?? ''
  }

  return {
    total: parseInt(searchData.esearchresult?.count ?? '0', 10),
    returned: articles.length,
    sort: 'relevance',
    note: articles.length < parseInt(searchData.esearchresult?.count ?? '0', 10)
      ? `Showing top ${articles.length} of ${searchData.esearchresult?.count} results. Refine your query to narrow results, or use date_range / MeSH terms for precision.`
      : undefined,
    query,
    articles,
  }
}

async function pubmedFetch({ pmid }) {
  const [summaryRaw, fetchRaw] = await Promise.all([
    get(apiUrl('esummary.fcgi', { db: 'pubmed', id: pmid })),
    get(apiUrl('efetch.fcgi', { db: 'pubmed', id: pmid, rettype: 'medline', retmode: 'text' })),
  ])

  const summary = JSON.parse(summaryRaw)
  const doc = summary.result?.[pmid] ?? {}

  // Extract MeSH terms from MEDLINE text
  const meshTerms = []
  for (const line of String(fetchRaw).split('\n')) {
    if (line.startsWith('MH  - ')) meshTerms.push(line.slice(6).trim())
  }

  // Extract abstract from MEDLINE text
  let abstract = ''
  let inAbstract = false
  for (const line of String(fetchRaw).split('\n')) {
    if (line.startsWith('AB  - ')) { inAbstract = true; abstract += line.slice(6) }
    else if (inAbstract && line.startsWith('      ')) abstract += ' ' + line.trim()
    else if (inAbstract) break
  }

  return {
    pmid,
    title: doc.title ?? '',
    authors: (doc.authors ?? []).map(a => a.name).join(', '),
    journal: doc.fulljournalname ?? doc.source ?? '',
    year: doc.pubdate?.split(' ')[0] ?? '',
    doi: doc.elocationid ?? '',
    pub_types: doc.pubtype ?? [],
    abstract: abstract.trim(),
    mesh_terms: meshTerms,
    nlm_url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
  }
}

async function pubmedRelated({ pmid, max_results = 10 }) {
  const linkData = JSON.parse(
    await get(apiUrl('elink.fcgi', {
      dbfrom: 'pubmed',
      db: 'pubmed',
      id: pmid,
      cmd: 'neighbor_score',
    }))
  )

  const linkSet = linkData.linksets?.[0]?.linksetdbs?.find(
    l => l.linkname === 'pubmed_pubmed'
  )
  const relatedIds = (linkSet?.links ?? [])
    .slice(0, max_results)
    .map(l => String(l.id ?? l))

  if (relatedIds.length === 0) return { pmid, related: [] }

  const summaryData = JSON.parse(
    await get(apiUrl('esummary.fcgi', { db: 'pubmed', id: relatedIds.join(',') }))
  )

  const related = relatedIds.map(id => {
    const doc = summaryData.result?.[id] ?? {}
    return {
      pmid: id,
      title: doc.title ?? '',
      authors: (doc.authors ?? []).slice(0, 3).map(a => a.name).join(', '),
      journal: doc.source ?? '',
      year: doc.pubdate?.split(' ')[0] ?? '',
    }
  })

  return { pmid, related }
}

// ── MCP server ─────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'pubmed', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'pubmed_search',
      description: 'Search PubMed for biomedical literature. Returns up to 10 articles by default (max 20), sorted by relevance, with full abstracts. QUERY BEST PRACTICE: AND 2-4 concepts together — not individual words. Use MeSH terms [MH] for diseases/drugs/procedures (most precise). Use [tiab] for molecular/genomic terms not in MeSH. Quote all multi-word phrases. Example: "carcinoma, non-small-cell lung"[MH] AND "exon 19 deletion"[tiab] AND immunotherapy[MH]. Never decompose one concept into individual AND\'d words (EGFR AND exon AND 19 AND deletion is wrong — use "exon 19 deletion"[tiab] instead).',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'PubMed query string. AND 2-4 concepts — not individual words. MeSH[MH] for diseases/drugs/procedures, [tiab] for molecular terms. Quote all multi-word phrases. Example: "carcinoma, non-small-cell lung"[MH] AND "exon 19 deletion"[tiab] AND immunotherapy[MH]',
          },
          max_results: {
            type: 'number',
            description: 'Maximum number of articles to return (default 10, max 20). Prefer refining the query over increasing this.',
          },
          date_range: {
            type: 'string',
            description: 'Date range filter as "YYYY:YYYY" e.g. "2020:2025"',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'pubmed_fetch',
      description: 'Fetch full details for a single PubMed article by PMID, including abstract and MeSH terms.',
      inputSchema: {
        type: 'object',
        properties: {
          pmid: { type: 'string', description: 'PubMed ID (numeric string)' },
        },
        required: ['pmid'],
      },
    },
    {
      name: 'pubmed_related',
      description: 'Find articles related to a given PubMed article (by PMID). Useful for expanding a literature search.',
      inputSchema: {
        type: 'object',
        properties: {
          pmid: { type: 'string', description: 'PubMed ID of the source article' },
          max_results: { type: 'number', description: 'Max related articles to return (default 10)' },
        },
        required: ['pmid'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args } = req.params

  try {
    let result
    if (name === 'pubmed_search') result = await pubmedSearch(args)
    else if (name === 'pubmed_fetch') result = await pubmedFetch(args)
    else if (name === 'pubmed_related') result = await pubmedRelated(args)
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
