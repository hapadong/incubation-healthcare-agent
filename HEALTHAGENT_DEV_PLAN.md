# HealthAgent v0.1.0 — Development Plan

**Base:** Claude Code v2.1.88 source
**Goal:** HIPAA-aligned, multi-agent clinical runtime for POC
**Target:** Cancer patient coordination + clinical research workflows
**Model:** Any OpenAI-compatible API endpoint (local, Azure-hosted, or otherwise org-controlled)

---

## Guiding Principles

- No patient data touches services outside org control — ever
- Compliance is infrastructure, not a feature
- Ship working tools fast; polish later
- Keep the agent runtime intact; replace only the cloud-dependent layers
- Every phase ends with something demonstrable
- No assumptions about institution-specific licenses or infrastructure

---

## Phase 0 — Strip & Harden
**Goal:** Clean base with no privacy liabilities
**Duration:** ~1 week
**Exit criteria:** Agent starts, runs, zero external calls except to configured model endpoint

### 0.1 Remove Telemetry

| Target | Location | Action |
|--------|----------|--------|
| Anthropic analytics | `src/services/analytics/` | Delete entire directory |
| Datadog sink | `src/services/analytics/datadogSink.ts` | Deleted with above |
| Analytics call sites | Throughout `src/` | Remove all `logAnalyticsEvent()` / `trackEvent()` calls |
| Telemetry in QueryEngine | `src/QueryEngine.ts` | Remove analytics hooks |
| Usage tracking | `src/services/api/` | Remove token/cost tracking that reports upstream |

### 0.2 Remove Claude.ai OAuth

| Target | Location | Action |
|--------|----------|--------|
| OAuth service | `src/services/oauth/` | Delete entire directory |
| Login command | `src/commands/login/` | Delete |
| Logout command | `src/commands/logout/` | Delete |
| OAuth config | `src/constants/oauth.ts` | Delete |
| Auth decision logic | `src/utils/auth.ts` | Simplify — API key from env or config file only |
| macOS Keychain dependency | `src/utils/secureStorage/` | Keep file-based storage only, remove Keychain calls |
| Subscription checks | Anywhere `subscriptionType` is checked | Remove or default to unrestricted |

**Replacement:** Single env var `HEALTHAGENT_API_KEY` or config file entry. No OAuth, no browser flow.

### 0.3 Remove External-Dependent Features

| Feature | Location | Action |
|---------|----------|--------|
| Remote triggers | `src/tools/RemoteTriggerTool/` | Delete — requires claude.ai backend |
| GitHub commands | `src/commands/pr/`, `src/commands/issue/` | Delete |
| Claude update/upgrade | `src/commands/update/` | Delete |
| Anthropic model version checks | `src/utils/model/` | Remove version pinning to Anthropic API |
| SSH remote execution | `src/commands/ssh/` | Keep — useful for org compute servers later |
| External OAuth MCP scopes | Any MCP claude.ai scope references | Remove |

### 0.4 Model API Abstraction Layer

Replace hardcoded Anthropic client with a clean, configurable API layer.

**File:** `src/services/api/client.ts`

**Config (env vars):**
```
HEALTHAGENT_API_BASE_URL=https://your-model-endpoint/v1
HEALTHAGENT_API_KEY=your-key
HEALTHAGENT_DEFAULT_MODEL=your-model-name
HEALTHAGENT_FAST_MODEL=your-fast-model-name
```

**Client logic:**
```typescript
// Single client path — always OpenAI-compatible
// Works with: Ollama, vLLM, Azure OpenAI, any org-controlled endpoint
const client = new OpenAI({
  baseURL: process.env.HEALTHAGENT_API_BASE_URL,
  apiKey: process.env.HEALTHAGENT_API_KEY ?? 'not-needed-for-local',
})
```

This works with any deployment: local Ollama, vLLM on org servers, Azure-hosted GPT-4o, or any OpenAI-compatible endpoint. The agent does not know or care how the model is served.

Strip all provider-specific client branches (Bedrock, Vertex, Foundry) — irrelevant for this product.
Strip all feature flags for internal Anthropic infra (`KAIROS`, `BRIDGE_MODE`, `COORDINATOR_MODE`, `DAEMON`, `VOICE_MODE`) — already dead code in npm build.

### 0.5 Deliverable

```
HEALTHAGENT_API_BASE_URL=https://org-model-server/v1 \
HEALTHAGENT_API_KEY=sk-xxx \
HEALTHAGENT_DEFAULT_MODEL=llama3.1-70b \
healthagent "hello"
→ Calls org model endpoint
→ Zero outbound traffic outside org network
→ Session saved locally
```

---

## Phase 1 — Compliance Layer
**Goal:** PHI protection + audit trail baked into the runtime
**Duration:** ~1 week
**Exit criteria:** Every input/output is scanned; every action is logged locally

### 1.1 PHI Scanner Hook (PreToolUse)

Built as a hook in `src/utils/hooks/`, registered automatically on startup.

**Detects all 18 HIPAA Safe Harbor identifiers:**
- Names, geographic subdivisions smaller than state (zip codes, addresses)
- Dates more specific than year (DOB, admission dates, discharge dates)
- Phone numbers, fax numbers, email addresses
- SSNs, MRNs, health plan beneficiary numbers, account numbers
- Certificate/license numbers, VINs, device identifiers
- Web URLs, IP addresses, biometric identifiers, full-face photos
- Any unique identifying number or code

**Behavior:**
- Warn on detection — never redact silently
- Log detection event (not the content) to audit trail
- Strict mode (configurable): block tool execution, require explicit user override
- Runs on every tool call input — deterministic regex, no ML, auditable

### 1.2 Local Audit Logger (PostToolUse + PostToolUseFailure)

Append-only log at `~/.healthagent/audit/YYYY-MM-DD.jsonl`

```json
{
  "timestamp": "2025-03-31T14:23:11Z",
  "session_id": "uuid",
  "user": "local-username",
  "action": "tool_call",
  "tool": "pubmed_search",
  "input_hash": "sha256-of-input",
  "phi_detected": false,
  "result_status": "success",
  "model": "llama3.1-70b",
  "duration_ms": 512
}
```

**Properties:**
- Append-only, no delete, no overwrite
- Inputs hashed (sha256), not stored — audit trail without PHI risk
- Daily log files, configurable retention (default 90 days)
- Exportable to CSV for compliance review

### 1.3 Consent Gate (Session Start)

Shown once per day on session start:
```
HealthAgent — Data Notice
This session is logged locally. Do not enter real patient identifiers.
Use de-identified or anonymized data only.
[Continue] [Exit]
```

Automatically skipped in batch/headless mode (`-p` flag).

### 1.4 Deliverable

```
healthagent "patient John Smith DOB 01/01/1980..."
→ PHI Scanner: "Warning: possible PHI detected (name, date of birth)"
→ Audit log entry written with input hash
→ User prompted to confirm or cancel
```

---

## Phase 2 — Clinical MCP Servers
**Goal:** Pre-built clinical data tools, all free/open APIs, no per-institution licenses required
**Duration:** ~2 weeks
**Exit criteria:** All 5 MCP servers functional, tested, documented

Each MCP server is a standalone Node.js process communicating via MCP stdio protocol.
No PHI stored in any MCP server — query tools only, return public data.
All APIs used are free and publicly accessible — no vendor licenses required.

### 2.1 PubMed MCP Server

**API:** NCBI E-utilities — free, public, no license required
**Rate limit:** 10 req/sec (no key), 100 req/sec (free NCBI API key)

**Tools exposed:**
- `pubmed_search(query, max_results, date_range)` → article list with PMID, title, abstract, authors, journal, year
- `pubmed_fetch(pmid)` → full abstract + MeSH terms + related links
- `pubmed_related(pmid)` → related article suggestions
- `pubmed_clinical_trials(condition, intervention)` → filters to clinical trial publication type

### 2.2 ClinicalTrials.gov MCP Server

**API:** ClinicalTrials.gov v2 API — free, public, no license required

**Tools exposed:**
- `trials_search(condition, intervention, phase, status)` → matching open trials
- `trial_detail(nct_id)` → full protocol, eligibility criteria, sites, contacts
- `trial_eligibility_check(nct_id, criteria)` → structured eligibility assessment against provided (de-identified) criteria
- `trials_by_location(condition, zip_code, radius_miles)` → geographically filtered trials

**Note:** `trial_eligibility_check` interprets eligibility text against criteria the user provides. No patient data stored or transmitted by the server.

### 2.3 Drug Information MCP Server

**APIs:** OpenFDA (free), RxNorm/NLM (free), NLM DailyMed (free) — all public, no license required

**Tools exposed:**
- `drug_lookup(name_or_ndc)` → label, indications, contraindications, warnings
- `drug_interactions(drug_list)` → interaction check across list of drugs
- `drug_rxnorm(drug_name)` → normalized drug name, RxNorm concept ID, synonyms
- `drug_adverse_events(drug_name, date_range)` → FAERS adverse event reports
- `drug_recalls(drug_name)` → active FDA drug recalls

**Interaction logic:** Rule-based lookup against NLM interaction pairs + FDA data. Deterministic, auditable.

### 2.4 Clinical Coding MCP Server

**APIs:** CMS ICD-10-CM/PCS (free), LOINC via NLM API (free with registration), SNOMED CT US Edition via NLM (free, US-only license)

**Tools exposed:**
- `icd10_search(description)` → matching ICD-10-CM codes ranked by relevance
- `icd10_lookup(code)` → code detail, hierarchy, inclusion/exclusion notes, valid for billing flag
- `loinc_search(test_name)` → LOINC code for lab tests and clinical observations
- `snomed_search(concept)` → SNOMED CT clinical concept lookup

**Note on CPT:** CPT procedure codes are proprietary to the AMA and require a per-organization license.
CPT is excluded from v0.1.0. It will be supported as an optional add-on module in a future version,
activated only when the institution provides their own AMA-licensed CPT data file.

### 2.5 Medical Guidelines MCP Server

**Sources:** NCI PDQ (public), USPSTF (public), NIH treatment guidelines (public), CDC guidelines (public)

**Tools exposed:**
- `nci_pdq_summary(cancer_type, summary_type)` → NCI cancer treatment summary (health professional or patient version)
- `uspstf_recommendation(topic)` → USPSTF grade + full recommendation text
- `nih_guideline(condition)` → NIH clinical guideline content
- `guideline_search(condition, topic)` → cross-source guideline search

**Scope for v0.1.0:** NCI PDQ (cancer-focused, matches POC target) + USPSTF. Others expandable post-POC.

### 2.6 MCP Server Registry

`config/mcp_servers.json` (ships with the product, no per-institution setup):
```json
{
  "pubmed":          { "command": "node", "args": ["./mcp/pubmed/index.js"] },
  "clinical_trials": { "command": "node", "args": ["./mcp/trials/index.js"] },
  "drugs":           { "command": "node", "args": ["./mcp/drugs/index.js"] },
  "coding":          { "command": "node", "args": ["./mcp/coding/index.js"] },
  "guidelines":      { "command": "node", "args": ["./mcp/guidelines/index.js"] }
}
```

---

## Phase 3 — Clinical Skills
**Goal:** Workflow-level behaviors composing the MCP tools into clinical tasks
**Duration:** ~1 week
**Exit criteria:** 4 skills working end-to-end, output useful to a clinical user

Skills are markdown prompt templates in `skills/`. They orchestrate Phase 2 MCP tools.
No user role assumptions — skills are general enough for any clinical user to invoke.

### 3.1 `/lit-review` — Structured Literature Review

**Trigger:** `/lit-review <clinical question>`

**Steps:**
1. Parse question into PICO format (Population, Intervention, Comparison, Outcome)
2. Call `pubmed_search` with structured MeSH-aware query
3. Fetch top 10 abstracts via `pubmed_fetch`
4. Synthesize: key findings, evidence level per article, clinical implications, evidence gaps
5. Return report with full citations (PMID + DOI where available)

**Output:** Markdown report with evidence level tags (RCT / systematic review / cohort / case series / expert opinion)

### 3.2 `/drug-check` — Drug Interaction Report

**Trigger:** `/drug-check <drug1>, <drug2>, ...`

**Steps:**
1. Normalize all drug names via `drug_rxnorm`
2. Run `drug_interactions` across full list
3. Fetch full label for each drug via `drug_lookup` (contraindications, warnings)
4. Check active recalls via `drug_recalls`
5. Synthesize interaction matrix with severity levels and clinical recommendations

**Output:** Severity-ranked table (Major / Moderate / Minor / No known interaction) + recommended actions + any active recall alerts

### 3.3 `/trial-match` — Clinical Trial Matching

**Trigger:** `/trial-match <condition> [age_range, stage, prior_treatments, location_zip]`

**Steps:**
1. Search `trials_search` with condition and filters
2. Run `trial_eligibility_check` on top results against provided criteria
3. Cross-reference against `nci_pdq_summary` for standard-of-care context
4. Rank by eligibility fit, trial phase, geographic proximity (if zip provided)
5. Return shortlist: NCT ID, title, phase, sponsor, key eligibility, site contacts

**Note:** Skill explicitly prompts: "Enter de-identified criteria only (no patient name, DOB, or MRN)"

### 3.4 `/visit-prep` — Patient Visit Preparation Checklist

**Trigger:** `/visit-prep <visit_type> [condition]`

**Steps:**
1. Retrieve relevant `nci_pdq_summary` or `nih_guideline` for condition
2. Generate what-to-bring checklist for that visit type
3. Generate pre-visit actions (labs, imaging, referrals to confirm)
4. Generate questions for the patient to ask the care team
5. Output in plain language (target: Grade 8 reading level)

**Output:** Three-section checklist — Before the visit / What to bring / Questions to ask
This directly addresses the cancer patient coordination problems: unclear expectations, missing documents, no next-step ownership.

---

## Phase 4 — POC Integration & Demo
**Goal:** End-to-end demonstrable workflow
**Duration:** ~1 week
**Exit criteria:** All modes functional, demo-ready

### 4.1 Cancer Patient Coordination Scenario

```
/visit-prep oncology-followup breast-cancer-stage-2
→ Checklist: labs to confirm, imaging CD to bring, questions to ask oncologist

/drug-check tamoxifen, anastrozole, ibuprofen, sertraline
→ Interaction report: sertraline + tamoxifen = Major (CYP2D6 inhibition, reduces tamoxifen efficacy)

/trial-match "breast cancer" stage=2 ER-positive prior-treatment=chemotherapy
→ 3 matching open trials with eligibility assessment and site contacts

/lit-review "adjuvant CDK4/6 inhibitors early-stage breast cancer 2024"
→ Structured evidence summary with 8 citations, evidence level tagged
```

### 4.2 Batch Mode

```bash
# Nightly oncology literature digest
echo '{"prompt": "/lit-review new breast cancer systemic therapy 2025"}' | \
  healthagent -p --input-format stream-json --output-format stream-json \
  >> /var/log/healthagent/digest_$(date +%Y-%m-%d).jsonl
```

### 4.3 Multi-User Server Mode

```bash
healthagent server --port 8080 --max-sessions 20 --auth-token $ORG_TOKEN
```

Multiple clinical team members connect via the server API or a thin web UI wrapper.

### 4.4 Audit Review

```bash
# Today's full audit trail
cat ~/.healthagent/audit/$(date +%Y-%m-%d).jsonl | jq .

# PHI detection events only
jq 'select(.phi_detected == true)' ~/.healthagent/audit/*.jsonl
```

---

## What v0.1.0 Is and Is Not

### Is
- Agent runtime with configurable OpenAI-compatible model endpoint
- 5 clinical MCP tools (PubMed, trials, drugs, ICD/LOINC/SNOMED coding, NCI/USPSTF guidelines)
- 4 clinical skills (lit review, drug check, trial match, visit prep)
- PHI scanner + local append-only audit log
- Interactive, batch, and server modes
- All data sources free/open — no per-institution licenses required
- Demonstrable cancer patient coordination scenario

### Is Not
- EHR integrated
- FDA cleared or formally HIPAA certified
- Patient-facing (clinical team tool only at this stage)
- CPT-enabled (proprietary AMA license — optional add-on in future version)
- Web UI (CLI and HTTP API; web UI is a future layer)
- Role-aware (role-based access and workflows are a future version)

---

## Repository Structure (Target)

```
healthagent/
├── src/                          # Modified runtime source
│   ├── services/api/client.ts    # OpenAI-compatible client (replaces Anthropic client)
│   └── utils/
│       ├── auth.ts               # Simplified: API key from env/config only
│       └── hooks/                # PHI scanner + audit logger
├── mcp/                          # Clinical MCP servers
│   ├── pubmed/
│   ├── trials/
│   ├── drugs/
│   ├── coding/
│   └── guidelines/
├── skills/                       # Clinical skill templates
│   ├── lit-review.md
│   ├── drug-check.md
│   ├── trial-match.md
│   └── visit-prep.md
├── config/
│   ├── mcp_servers.json          # MCP registry (ships with product)
│   └── CLAUDE.md                 # Healthcare system prompt
└── scripts/
    └── install.sh                # Setup script for org deployment
```

---

## New Dependencies

```json
{
  "openai": "^4.x",
  "@modelcontextprotocol/sdk": "^1.x"
}
```

`openai` is used as a generic OpenAI-compatible HTTP client only — not for OpenAI API access. Works with any compliant endpoint.

---

## Phase Summary

| Phase | Work | Duration | Deliverable |
|-------|------|----------|-------------|
| 0 — Strip & Harden | Remove telemetry, OAuth, Anthropic-specific deps; add model API abstraction | 1 week | Clean, org-deployable base |
| 1 — Compliance Layer | PHI scanner hook, local audit log, consent gate | 1 week | Every action logged, PHI flagged |
| 2 — Clinical MCP Servers | 5 servers, all free APIs, no per-org licenses | 2 weeks | PubMed, trials, drugs, coding, guidelines |
| 3 — Clinical Skills | 4 skill workflows composing MCP tools | 1 week | /lit-review, /drug-check, /trial-match, /visit-prep |
| 4 — POC Demo | End-to-end integration, batch + server modes | 1 week | Demo-ready |
| **Total** | | **~6 weeks** | **v0.1.0 POC** |
