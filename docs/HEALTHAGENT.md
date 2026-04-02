# HealthAgent Development Plan

Verity Health Agent — a clinical AI assistant built on the Claude Code CLI, configured to run against Azure OpenAI (or any OpenAI-compatible endpoint).

---

## Product Vision

HealthAgent is a **clinical AI platform**, not just a CLI tool. The CLI is the backend engine. The end-state is a hosted service with a web UI on top:

```
Customers (clinicians, care teams)
        ↓
HealthAgent Web UI        — charts, structured patient views, exportable reports
        ↓
HealthAgent Service       — this codebase (the engine)
        ↓
Azure OpenAI (gpt-4o)     — HIPAA BAA-covered model backend
        ↓
Clinical MCP tools        — MIMIC, PubMed, trials, drugs, patient records...
```

**What makes this a real clinical product vs. stock Claude Code + MCP:**

| Differentiator | Why it matters |
|----------------|---------------|
| **Azure OpenAI backend** | Azure has HIPAA BAA coverage — deployable in real clinical settings. Anthropic currently does not offer a BAA. |
| **PHI guardrail** | PreToolUse hook scans external calls for SSN, email, phone patterns before data leaves the system. No equivalent in stock Claude Code. |
| **Audit trail** | Every tool call logged to append-only JSONL. Required for clinical compliance. |
| **Patient persistence** | Stateful patient records on disk — not a stateless chatbot. Survives across sessions. |
| **Compiled skills with gating** | Skills enabled/disabled by environment, with dynamic prompts. Markdown skills in stock Claude Code can't do this. |
| **Web UI (planned)** | Productized interface with native chart rendering, structured clinical views, PDF export. |
| **Owned stack** | Full control over pricing, data, customization, and customer relationships. |

The CLI remains useful for power users and internal development. Customers will interact exclusively through the web UI.

---

## Architecture Overview

```
HealthAgent CLI (Claude Code fork)
  ├── Model backend: Azure OpenAI gpt-4o (or Ollama / vLLM)
  ├── PHI guardrail: PreToolUse hook scans external calls
  ├── Audit trail: PostToolUse hook → ~/.healthagent/audit/YYYY-MM-DD.jsonl
  ├── MCP servers: clinical knowledge tools (Phase 2+)
  ├── Bundled skills: clinical workflow automation (Phase 3+)
  └── Patient persistence: ~/.healthagent/patients/ (Phase 5)
```

Activated by setting `HEALTHAGENT_API_BASE_URL` in `.env`. See `.env` for all configuration options.

---

## Phase 1 — Compliance Infrastructure ✅

Built in `src/utils/healthagent/`:

| File | Purpose |
|------|---------|
| `complianceHooks.ts` | PreToolUse hook — scans external tool calls for PHI patterns, blocks if detected |
| `phiScanner.ts` | Regex patterns for SSN, email, phone detection on external tools |
| `auditLogger.ts` | PostToolUse hook — appends every tool call to append-only JSONL audit log |

System prompt injection (`src/constants/prompts.ts`): de-identification instruction added when `HEALTHAGENT_API_BASE_URL` is set.

---

## Phase 2 — Clinical MCP Servers ✅

Five MCP servers in `mcp/`, each a standalone Node.js process (stdio transport). Registered in `.mcp.json`.

### pubmed — NCBI E-utilities
```
mcp/pubmed/index.js
Tools: pubmed_search, pubmed_fetch, pubmed_related
API: https://eutils.ncbi.nlm.nih.gov (NCBI_API_KEY optional, 10→100 req/s)
```

### trials — ClinicalTrials.gov v2
```
mcp/trials/index.js
Tools: trials_search, trial_detail
API: https://clinicaltrials.gov/api/v2 (no key required)
Notes: phase filter is client-side (API returns 400 for filter.phase)
```

### drugs — OpenFDA + NLM RxNorm
```
mcp/drugs/index.js
Tools: drug_lookup, drug_adverse_events, drug_recalls, drug_rxnorm
APIs: https://api.fda.gov, https://rxnav.nlm.nih.gov (OPENFDA_API_KEY optional)
Notes: drug_lookup tries brand → generic → substance internally; call once per drug
```

### coding — NLM Clinical Tables
```
mcp/coding/index.js
Tools: icd10_search, loinc_search
API: https://clinicaltables.nlm.nih.gov (no key required)
Notes: ICD-10 uses clinical terminology; model translates lay terms before searching
```

### guidelines — PubMed + NLM MedlinePlus
```
mcp/guidelines/index.js
Tools: guidelines_search, health_topic
APIs: NCBI E-utilities (practice guideline[pt] filter), wsearch.nlm.nih.gov
Notes: year_from only set when user explicitly states a date range
```

All tools listed in `HEALTHAGENT_INTERNAL_TOOLS` env var to bypass PHI guardrail (queries are de-identified clinical terms).

---

## Phase 3 — Clinical Skills ✅

Six bundled skills in `src/skills/bundled/`, gated on `HEALTHAGENT_API_BASE_URL`. All skill descriptions/whenToUse fields are kept neutral to avoid Azure OpenAI content filter triggering on every request.

### `/lit-review` — Literature Review
```
src/skills/bundled/litReview.ts
MCP: guidelines_search, pubmed_search, pubmed_fetch
Input: clinical question (free text)
Output: guidelines summary, research findings by study type, gaps, references
```

### `/trial-match` — Trial Matching
```
src/skills/bundled/trialMatch.ts
MCP: trials_search, trial_detail
Input: patient profile (diagnosis, stage, biomarkers, ECOG, prior tx, location)
Output: per-trial eligibility table (✅/⚠️/❌ per criterion), ranked candidates
```

### `/med-recon` — Medication Reconciliation
```
src/skills/bundled/medRecon.ts
MCP: drug_lookup, drug_adverse_events, drug_recalls
Input: medication list (name, dose, frequency)
Output: duplicate therapy flags, drug-drug interactions, high-risk drug alerts, recall alerts
```

### `/clinical-coding` — Clinical Coding Assistant
```
src/skills/bundled/clinicalCoding.ts
MCP: icd10_search, loinc_search
Input: clinical note or diagnosis list
Output: ICD-10 codes per diagnosis, LOINC codes for labs/observations, confidence ratings
```

### `/visit-prep` — Visit Preparation Checklist
```
src/skills/bundled/visitPrep.ts
MCP: guidelines_search, drug_adverse_events, trials_search, loinc_search
Input: patient context + reason for visit
Output: pre-visit checklist (labs to review, symptoms to assess, guideline actions, orders, trials to discuss)
```

### `/patient-summary` — Patient Summary
```
src/skills/bundled/patientSummary.ts
MCP: drug_rxnorm (optional), icd10_search (optional)
Input: clinical notes, discharge summary, or scattered patient data
Output: structured one-pager (problem list, medications, timeline, active issues, handoff one-liner)
Notes: calls tools selectively — only when drug names are ambiguous or codes are missing
```

---

## Known Issues & Workarounds

| Issue | Cause | Fix |
|-------|-------|-----|
| Azure content filter blocks all requests | Skill description/whenToUse with clinical terms injected into every API call | Keep skill description/whenToUse fields neutral — detail goes in the skill prompt only |
| `year_from` added when user says "current" | Model infers recency from natural language | Tool description explicitly says: only set year_from when user gives an explicit year |
| MedlinePlus `health_topic` returns 0 results | `<document>` regex expected `url` as first attribute; actual XML has `rank` first | Fixed: regex now `/<document[^>]+url="..."/` |
| RxNorm `related.json?tty=BN+IN` returns 400 | API does not support tty filtering on that endpoint | Fixed: use `allrelated.json`, filter by tty in code |
| ClinicalTrials filter.phase HTTP 400 | `filter.phase` is not a valid v2 API param | Fixed: fetch 3× results, filter client-side by `protocolSection.designModule.phases` |

---

## Configuration Reference

```bash
# Model endpoint (choose one)
HEALTHAGENT_API_BASE_URL=https://your-resource.openai.azure.com/openai/v1
HEALTHAGENT_API_KEY=your-key
HEALTHAGENT_MODEL=gpt-4o

# Optional
HEALTHAGENT_SYSTEM_PREFIX=You are HealthAgent...
HEALTHAGENT_AZURE_API_VERSION=2025-01-01-preview

# Search
HEALTHAGENT_SEARCH_PROVIDER=tavily
HEALTHAGENT_SEARCH_API_KEY=your-key

# MCP keys
OPENFDA_API_KEY=your-key
NCBI_API_KEY=your-key

# PHI guardrail bypass for internal MCP tools
HEALTHAGENT_INTERNAL_TOOLS=pubmed__pubmed_search,pubmed__pubmed_fetch,...
```

---

---

## Phase 4 — MIMIC-IV Integration ✅

Real de-identified clinical data from MIMIC-IV v3.1 via Google BigQuery.

### mimic — MIMIC-IV BigQuery
```
mcp/mimic/index.js
Tools: mimic_patient, mimic_labs, mimic_cohort, mimic_icu, mimic_sql
Auth: Application Default Credentials (gcloud auth application-default login)
Billing: GCP project mimic-491221 (MIMIC_GCP_PROJECT env var)
Datasets: physionet-data.mimiciv_3_1_hosp, physionet-data.mimiciv_3_1_icu
```

| Tool | Description |
|------|-------------|
| `mimic_patient` | Demographics, diagnoses (ICD), medications for a subject_id |
| `mimic_labs` | Recent lab results with flag (normal/abnormal) |
| `mimic_cohort` | Find patients by ICD code or diagnosis keyword |
| `mimic_icu` | ICU stay summary + latest vitals (HR, BP, SpO2, GCS, temp) |
| `mimic_sql` | Execute arbitrary BigQuery SQL for analytics; SELECT/WITH only, capped at 1000 rows |

**POC demo flow:**
```
/patient load 10032        → fetch from MIMIC, save to disk, load into session
/trial-match               → eligible trials using loaded patient context
/med-recon                 → medication safety check
/mimic-analytics <question> → natural language → SQL → results + Python plot
```

**Notes:**
- MIMIC dates are shifted for de-identification — do not compare to real dates
- Notes module (`mimiciv_note`) requires separate PhysioNet credentialing
- ADC credentials auto-refresh; no manual token management needed

---

## Phase 5 — Orchestration Skills & Patient Persistence ✅

### New skills

| Skill | Command | Description |
|-------|---------|-------------|
| `/mimic-workflow` | `/mimic-workflow <condition>` | End-to-end: find patient → profile → labs → summary → trials → med safety |
| `/mimic-analytics` | `/mimic-analytics <question>` | Natural language → BigQuery SQL → results → Python matplotlib script |
| `/patient` | `/patient list\|load\|new\|refresh\|update` | Manage persistent patient records on disk |

### patients — Patient Record Store
```
mcp/patients/index.js
Tools: patient_list, patient_load, patient_save, patient_update, patient_generate_id
Storage: ~/.healthagent/patients/<id>.json
```

| Tool | Description |
|------|-------------|
| `patient_list` | List all saved patient records |
| `patient_load` | Load a record by ID; returns 404 with available IDs if not found |
| `patient_save` | Create new record; rejects hollow saves (raw_text with no structured fields) |
| `patient_update` | Merge-update specific fields of an existing record |
| `patient_generate_id` | Generate sequential ID: `manual_YYYYMMDD_NNN` |

**Patient ID conventions:**
- MIMIC patients: `mimic_<subject_id>` (e.g. `mimic_10032`)
- Manual (free text) patients: `manual_YYYYMMDD_NNN` (e.g. `manual_20260402_001`)

**Two sources of patient data:**
```
/patient load 10032             → fetches from MIMIC BigQuery, saves to disk
/patient new "67M with NSTEMI..." → extracts structured data from free text, saves to disk
```

**Design rules:**
- Patient records are updated only by explicit load/refresh/update commands — skills are read-only consumers
- `patient_save` validates: if raw_text is provided, at least one structured field must be non-empty
- No auto-load; user must explicitly issue `/patient load <id>`

---

## Bug Fixes & Stability

| Issue | Fix |
|-------|-----|
| `SandboxManager.getSandboxViolationStore is not a function` | Stubbed missing method in `sandbox-adapter.ts` — installed package lacks it |
| gpt-4o spawns `Agent` tool for every skill invocation | `AgentTool.isEnabled()` returns `false` when `HEALTHAGENT_API_BASE_URL` is set |
| Azure OpenAI rejects array schemas without `items` | Added `items: { type: 'object' }` to all array fields in MCP tool schemas |
| `patient_save` accepts hollow records | Server-side validation rejects saves where raw_text present but all structured fields empty |

---

## Pending / Future Work

- **Web UI** — thin Express + React wrapper over existing backend; renders charts natively (no Python script needed), structured patient views, multi-panel layout
- **SNOMED CT** — requires UTS API key from https://uts.nlm.nih.gov (registration required)
- **Azure content filter** — configure gpt-4o deployment in Azure AI Foundry to use a less restrictive content filter profile
