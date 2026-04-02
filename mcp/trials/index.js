#!/usr/bin/env node
/**
 * ClinicalTrials.gov MCP Server — Verity Health Agent
 *
 * Tools:
 *   trials_search  — search open/recruiting trials by condition + intervention
 *   trial_detail   — full protocol, eligibility, sites for a single NCT ID
 *
 * Uses ClinicalTrials.gov v2 API (free, public, no API key required).
 * https://clinicaltrials.gov/data-api/api
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import https from 'https'

const CT_BASE = 'https://clinicaltrials.gov/api/v2'

// ── HTTP helper ────────────────────────────────────────────────────────────────

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`ClinicalTrials.gov returned HTTP ${res.statusCode} for ${url}`))
        } else {
          resolve(data)
        }
      })
    }).on('error', reject)
  })
}

function apiUrl(path, params) {
  const p = new URLSearchParams({ format: 'json', ...params })
  return `${CT_BASE}${path}?${p}`
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function extractStudySummary(study) {
  const s = study.protocolSection ?? {}
  const id = s.identificationModule ?? {}
  const status = s.statusModule ?? {}
  const design = s.designModule ?? {}
  const cond = s.conditionsModule ?? {}
  const arms = s.armsInterventionsModule ?? {}
  const elig = s.eligibilityModule ?? {}

  const interventions = (arms.interventions ?? [])
    .map(i => `${i.name} (${i.type})`)
    .slice(0, 5)

  return {
    nct_id: id.nctId ?? '',
    title: id.briefTitle ?? '',
    status: status.overallStatus ?? '',
    phase: (design.phases ?? []).join(', ') || 'N/A',
    conditions: cond.conditions ?? [],
    interventions,
    start_date: status.startDateStruct?.date ?? '',
    primary_completion: status.primaryCompletionDateStruct?.date ?? '',
    eligibility_summary: {
      sex: elig.sex ?? 'ALL',
      min_age: elig.minimumAge ?? '',
      max_age: elig.maximumAge ?? '',
      healthy_volunteers: elig.healthyVolunteers ?? false,
    },
    url: `https://clinicaltrials.gov/study/${id.nctId}`,
  }
}

// ── Tool implementations ───────────────────────────────────────────────────────

async function trialsSearch({ condition, intervention, phase, status = 'RECRUITING', max_results = 10 }) {
  const params = {
    pageSize: String(Math.min(max_results, 20)),
  }

  // Build query — condition is required, others optional
  if (condition) params['query.cond'] = condition
  if (intervention) params['query.intr'] = intervention

  // Phase filter: PHASE1, PHASE2, PHASE3, PHASE4, EARLY_PHASE1, NA
  if (phase) params['filter.phase'] = phase.toUpperCase().replace(/\s+/g, '_')

  // Status filter: RECRUITING, NOT_YET_RECRUITING, ACTIVE_NOT_RECRUITING, COMPLETED, etc.
  if (status) params['filter.overallStatus'] = status.toUpperCase()

  const data = JSON.parse(await get(apiUrl('/studies', params)))
  const studies = data.studies ?? []

  return {
    total: data.totalCount ?? studies.length,
    returned: studies.length,
    status_filter: status,
    note: studies.length < (data.totalCount ?? 0)
      ? `Showing ${studies.length} of ${data.totalCount} matching trials. Narrow with phase, intervention, or status filters.`
      : undefined,
    trials: studies.map(extractStudySummary),
  }
}

async function trialDetail({ nct_id }) {
  const data = JSON.parse(await get(apiUrl(`/studies/${nct_id}`, {})))
  const s = data.protocolSection ?? {}

  const id = s.identificationModule ?? {}
  const status = s.statusModule ?? {}
  const design = s.designModule ?? {}
  const desc = s.descriptionModule ?? {}
  const cond = s.conditionsModule ?? {}
  const arms = s.armsInterventionsModule ?? {}
  const elig = s.eligibilityModule ?? {}
  const outcomes = s.outcomesModule ?? {}
  const contacts = s.contactsLocationsModule ?? {}
  const sponsor = s.sponsorCollaboratorsModule ?? {}

  // Locations — cap at 10 to avoid token bloat
  const locations = (contacts.locations ?? []).slice(0, 10).map(loc => ({
    facility: loc.facility ?? '',
    city: loc.city ?? '',
    state: loc.state ?? '',
    country: loc.country ?? '',
    status: loc.status ?? '',
    contact: loc.contacts?.[0]
      ? `${loc.contacts[0].name ?? ''} ${loc.contacts[0].phone ?? ''}`.trim()
      : '',
  }))

  return {
    nct_id: id.nctId ?? nct_id,
    title: id.briefTitle ?? '',
    official_title: id.officialTitle ?? '',
    status: status.overallStatus ?? '',
    phase: (design.phases ?? []).join(', ') || 'N/A',
    study_type: design.studyType ?? '',
    conditions: cond.conditions ?? [],
    interventions: (arms.interventions ?? []).map(i => ({
      type: i.type,
      name: i.name,
      description: i.description ?? '',
    })),
    brief_summary: desc.briefSummary ?? '',
    eligibility: {
      criteria: elig.eligibilityCriteria ?? '',
      sex: elig.sex ?? 'ALL',
      min_age: elig.minimumAge ?? '',
      max_age: elig.maximumAge ?? '',
      healthy_volunteers: elig.healthyVolunteers ?? false,
      std_ages: elig.stdAges ?? [],
    },
    primary_outcomes: (outcomes.primaryOutcomes ?? []).map(o => ({
      measure: o.measure ?? '',
      time_frame: o.timeFrame ?? '',
    })),
    sponsor: sponsor.leadSponsor?.name ?? '',
    start_date: status.startDateStruct?.date ?? '',
    primary_completion: status.primaryCompletionDateStruct?.date ?? '',
    enrollment: design.enrollmentInfo?.count ?? null,
    locations_shown: locations.length,
    locations_total: (contacts.locations ?? []).length,
    locations,
    url: `https://clinicaltrials.gov/study/${id.nctId ?? nct_id}`,
  }
}

// ── MCP server ─────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'trials', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'trials_search',
      description: 'Search ClinicalTrials.gov for clinical trials. Returns trials with title, status, phase, interventions, and eligibility summary. Default filter is RECRUITING. Use for finding open trials matching a patient\'s condition and potential treatment.',
      inputSchema: {
        type: 'object',
        properties: {
          condition: {
            type: 'string',
            description: 'Disease or condition to search for. Use medical terminology: "non-small cell lung cancer", "EGFR mutation", "type 2 diabetes". Supports free text and MeSH-style terms.',
          },
          intervention: {
            type: 'string',
            description: 'Drug, device, or procedure of interest. E.g. "osimertinib", "immunotherapy", "CAR-T". Optional.',
          },
          phase: {
            type: 'string',
            description: 'Trial phase filter: PHASE1, PHASE2, PHASE3, PHASE4, EARLY_PHASE1. Optional.',
          },
          status: {
            type: 'string',
            description: 'Recruitment status filter. Default: RECRUITING. Options: RECRUITING, NOT_YET_RECRUITING, ACTIVE_NOT_RECRUITING, COMPLETED, ENROLLING_BY_INVITATION.',
          },
          max_results: {
            type: 'number',
            description: 'Max trials to return (default 10, max 20). Use narrow search terms rather than increasing this.',
          },
        },
        required: ['condition'],
      },
    },
    {
      name: 'trial_detail',
      description: 'Fetch full details for a single clinical trial by NCT ID. Returns full eligibility criteria text, all interventions, primary outcomes, sponsor, and up to 10 site locations with contacts. Use after trials_search to get full protocol details.',
      inputSchema: {
        type: 'object',
        properties: {
          nct_id: {
            type: 'string',
            description: 'ClinicalTrials.gov NCT identifier, e.g. "NCT04410796"',
          },
        },
        required: ['nct_id'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args } = req.params

  try {
    let result
    if (name === 'trials_search') result = await trialsSearch(args)
    else if (name === 'trial_detail') result = await trialDetail(args)
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
