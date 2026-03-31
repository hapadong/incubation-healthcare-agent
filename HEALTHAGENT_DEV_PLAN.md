# HealthAgent v0.1.0 — Development Plan

**Base:** Claude Code v2.1.88 source
**Goal:** On-premise, HIPAA-aligned, multi-agent clinical runtime for POC
**Target:** Cancer patient coordination + clinical research workflows
**Model:** Local LLM (Ollama / vLLM) — data never leaves institution

---

## Guiding Principles

- No patient data touches external services — ever
- Compliance is infrastructure, not a feature
- Ship working tools fast; polish later
- Keep the agent runtime intact; replace only the cloud-dependent layers
- Every phase ends with something demonstrable

---

## Phase 0 — Strip & Harden
**Goal:** Clean base with no privacy liabilities
**Duration:** ~1 week
**Exit criteria:** Agent starts, runs locally, zero external calls except to local model

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
| Login command | `src/commands/login/` | Delete, replace with placeholder |
| Logout command | `src/commands/logout/` | Delete |
| OAuth config | `src/constants/oauth.ts` | Delete |
| Auth decision logic | `src/utils/auth.ts` | Simplify to API key + local token only |
| Secure keychain storage | `src/utils/secureStorage/` | Keep file-based storage, remove macOS keychain dependency |
| Subscription checks | Anywhere `subscriptionType` is checked | Remove or default to unrestricted |

**Replacement:** Single env var `HEALTHAGENT_API_TOKEN` or config file key pointing to local model.

### 0.3 Remove External-Dependent Features

| Feature | Location | Action |
|---------|----------|--------|
| Remote triggers | `src/tools/RemoteTriggerTool/` | Delete (cloud-dependent, requires claude.ai backend) |
| GitHub commands | `src/commands/pr/`, `src/commands/issue/` | Delete |
| Claude update/upgrade | `src/commands/update/` | Delete |
| Anthropic model version checks | `src/utils/model/` | Remove version pinning to Anthropic API |
| SSH remote execution | `src/commands/ssh/` | Keep for later — useful for hospital compute servers |
| External OAuth MCP | Any MCP auto-importing claude.ai scopes | Remove scope references |

### 0.4 Harden Base Config

- Lock `baseURL` to local model endpoint via env: `HEALTHAGENT_MODEL_BASE_URL`
- Remove hardcoded `https://api.anthropic.com` references from `src/services/api/client.ts`
- Add new client branch: if `HEALTHAGENT_MODEL_BASE_URL` set → use OpenAI-compatible client
- Set default model to configurable via `HEALTHAGENT_DEFAULT_MODEL` env var
- Strip all feature flags for internal Anthropic infra (`KAIROS`, `BRIDGE_MODE`, `COORDINATOR_MODE`, `DAEMON`, `VOICE_MODE`) — they're already dead code in npm build, just confirm

### 0.3 Deliverable

```
healthagent "hello"
→ Calls local Ollama/vLLM endpoint
→ No outbound network traffic to Anthropic
→ Session saved locally
→ Audit log written locally
```

---

## Phase 1 — Compliance Layer
**Goal:** PHI protection + audit trail baked into the runtime
**Duration:** ~1 week
**Exit criteria:** Every input/output is scanned; every action is logged locally

### 1.1 PHI Scanner Hook (PreToolUse)

Build as a hook (`src/utils/hooks/` + register in settings):

**Detects 18 HIPAA Safe Harbor identifiers:**
- Names, geographic data (zip codes, addresses), dates (except year), phone numbers, fax numbers
- Email addresses, SSNs, MRNs, health plan numbers, account numbers
- Certificate/license numbers, VINs, device identifiers, URLs, IPs
- Biometric identifiers, full-face photos, any unique identifying number

**Behavior:**
- Warn user when PHI detected in input
- Log detection event to audit trail
- In strict mode: block tool execution, require explicit override
- Never redact silently — always surface to user

**Implementation:** Regex + pattern matching. Keep it fast (runs on every tool call). No ML model — deterministic, auditable.

### 1.2 Local Audit Logger (PostToolUse + PostToolUseFailure)

Append-only local log at `~/.healthagent/audit/YYYY-MM-DD.jsonl`

Each entry:
```json
{
  "timestamp": "ISO-8601",
  "session_id": "uuid",
  "user": "local-username",
  "action": "tool_call",
  "tool": "BashTool",
  "input_hash": "sha256 of input",
  "phi_detected": false,
  "result_status": "success",
  "model": "llama3-70b",
  "duration_ms": 342
}
```

**Properties:**
- Append-only (no delete, no overwrite)
- Inputs hashed, not stored (audit trail without PHI exposure)
- Log rotation: daily files, 90-day retention configurable
- Exportable to CSV for compliance review

### 1.3 Consent Gate (Session Start)

On first session of each day, prompt:
```
HealthAgent — HIPAA Notice
This session is logged locally. Do not enter real patient identifiers.
Use de-identified or anonymized data only.
[Continue] [Exit]
```

Configurable: skip in automated/batch mode.

### 1.4 Deliverable

```
healthagent "patient John Smith DOB 01/01/1980..."
→ PHI Scanner fires: "Warning: possible PHI detected (name, date)"
→ Audit log entry written
→ User prompted to confirm before proceeding
```

---

## Phase 2 — Local Model Integration
**Goal:** Full local LLM support, tested and stable
**Duration:** ~3–5 days
**Exit criteria:** Runs on Llama 3.1 70B via Ollama and Mistral 7B via vLLM

### 2.1 API Client Modification

File: `src/services/api/client.ts`

Add new client branch:
```typescript
if (process.env.HEALTHAGENT_MODEL_BASE_URL) {
  // OpenAI-compatible client
  // Points to Ollama (:11434) or vLLM (:8000)
  // No auth header needed for local; optional bearer token for internal network
}
```

### 2.2 Model Configuration

Environment variables:
```
HEALTHAGENT_MODEL_BASE_URL=http://localhost:11434/v1   # Ollama
HEALTHAGENT_DEFAULT_MODEL=llama3.1:70b
HEALTHAGENT_FAST_MODEL=llama3.1:8b                    # For quick tasks
HEALTHAGENT_MAX_TOKENS=8192
```

### 2.3 Tested Configurations

| Model | Use case | Hardware requirement |
|-------|---------|---------------------|
| Llama 3.1 70B (Q4) | Primary reasoning, complex clinical tasks | 48GB VRAM |
| Llama 3.1 8B | Fast responses, simple lookups | 8GB VRAM |
| Mistral 7B | Lightweight, batch jobs | 8GB VRAM |
| MedGemma 27B | Medical-specific reasoning (optional) | 24GB VRAM |

### 2.4 Deliverable

```
HEALTHAGENT_MODEL_BASE_URL=http://localhost:11434/v1 \
HEALTHAGENT_DEFAULT_MODEL=llama3.1:70b \
healthagent "summarize this clinical trial abstract"
→ Runs on local Llama 3.1, no external API calls
```

---

## Phase 3 — Clinical MCP Servers
**Goal:** Pre-built, compliant clinical data tools
**Duration:** ~2 weeks
**Exit criteria:** All 5 MCP servers functional, tested, documented

Each MCP server is a standalone Node.js/Python process exposing tools via MCP stdio protocol. No PHI stored in MCP servers — they are query tools only.

### 3.1 PubMed MCP Server

**Source:** Build on top of community base, add production hardening
**API:** NCBI E-utilities (free, no auth required for basic use; API key for higher rate limits)

**Tools exposed:**
- `pubmed_search(query, max_results, date_range)` → list of articles with PMID, title, abstract, authors, journal, year
- `pubmed_fetch(pmid)` → full abstract + MeSH terms + references
- `pubmed_related(pmid)` → related articles
- `pubmed_clinical_trials(condition, intervention)` → filter to clinical trial article types

**Rate limiting:** 10 req/sec without key, 100/sec with NCBI API key
**No PHI:** Query terms only, returns public data

### 3.2 ClinicalTrials.gov MCP Server

**API:** ClinicalTrials.gov v2 API (free, public)

**Tools exposed:**
- `trials_search(condition, intervention, phase, status, location)` → matching trials
- `trial_detail(nct_id)` → full protocol, eligibility criteria, contacts, locations
- `trial_eligibility_check(nct_id, patient_criteria)` → structured eligibility assessment
- `trials_nearby(condition, zip_code, radius_miles)` → geographically filtered trials

**Note on eligibility check:** Agent interprets eligibility criteria against de-identified patient criteria provided by clinician — no PHI stored

### 3.3 Drug Information MCP Server

**APIs:** OpenFDA (free), RxNorm (NLM, free), NLM DailyMed

**Tools exposed:**
- `drug_lookup(name_or_ndc)` → drug label, indications, contraindications
- `drug_interactions(drug_list)` → interaction check across provided drug list
- `drug_rxnorm(drug_name)` → RxNorm normalization, concept ID, synonyms
- `drug_adverse_events(drug_name, date_range)` → FDA adverse event reports (FAERS)
- `drug_recalls(drug_name)` → active FDA recalls

**Interaction logic:** Rule-based lookup against known interaction pairs from NLM + FDA data. Not ML inference — deterministic, auditable.

### 3.4 Clinical Coding MCP Server

**Sources:** CMS ICD-10-CM/PCS files (free), AMA CPT open access subset, SNOMED CT (license required for full), LOINC (free with registration)

**Tools exposed:**
- `icd10_search(description)` → matching ICD-10-CM codes with descriptions
- `icd10_lookup(code)` → full code detail, hierarchy, inclusion/exclusion notes
- `cpt_lookup(code)` → CPT code description (open subset)
- `loinc_search(test_name)` → LOINC code for lab/clinical observations
- `snomed_search(concept)` → SNOMED CT concept lookup

**Note:** Full CPT database requires AMA license. Open subset covers common codes for POC.

### 3.5 Medical Guidelines MCP Server

**Sources:** USPSTF (public), NCI PDQ (public), NIH guidelines (public), CDC guidelines (public)

**Tools exposed:**
- `guideline_search(condition, topic)` → matching clinical guidelines
- `uspstf_recommendation(topic)` → USPSTF grade + recommendation text
- `nci_pdq_summary(cancer_type, audience)` → NCI cancer treatment summaries
- `nih_guideline(condition)` → NIH treatment guidelines

**Scope for v0.1.0:** NCI PDQ cancer summaries + USPSTF. Expandable later.

### 3.6 MCP Server Registry

All servers configured in `~/.healthagent/mcp_servers.json`:
```json
{
  "pubmed": { "command": "node", "args": ["./mcp/pubmed/index.js"] },
  "clinical_trials": { "command": "node", "args": ["./mcp/trials/index.js"] },
  "drugs": { "command": "node", "args": ["./mcp/drugs/index.js"] },
  "coding": { "command": "node", "args": ["./mcp/coding/index.js"] },
  "guidelines": { "command": "node", "args": ["./mcp/guidelines/index.js"] }
}
```

---

## Phase 4 — Clinical Skills
**Goal:** Workflow-level behaviors for specific clinical tasks
**Duration:** ~1 week
**Exit criteria:** 4 working skills demonstrable to a clinical user

Skills are markdown prompt templates stored in `.healthagent/skills/`. Each skill orchestrates the MCP tools from Phase 3.

### 4.1 `/lit-review` — Literature Review

**Trigger:** `/lit-review <clinical question>`
**Steps:**
1. Parse question into PICO format (Population, Intervention, Comparison, Outcome)
2. Call `pubmed_search` with structured query
3. Fetch abstracts for top 10 results
4. Synthesize: summary, evidence level, key findings, gaps
5. Output structured report with citations (PMID links)

**Output format:** Markdown report, evidence level tagged (RCT / systematic review / observational / expert opinion)

### 4.2 `/drug-check` — Drug Interaction Report

**Trigger:** `/drug-check <drug1>, <drug2>, ...`
**Steps:**
1. Normalize each drug name via `drug_rxnorm`
2. Run `drug_interactions` across full list
3. Look up each drug via `drug_lookup` for contraindications
4. Synthesize: interaction matrix, severity levels, clinical recommendations
5. Flag any active recalls via `drug_recalls`

**Output format:** Severity-ranked table (Major / Moderate / Minor) + clinical action recommendations

### 4.3 `/trial-match` — Clinical Trial Matching

**Trigger:** `/trial-match <condition> [criteria: age, stage, prior_treatment]`
**Steps:**
1. Search `trials_search` by condition + filters
2. For each result, run `trial_eligibility_check` against provided criteria
3. Rank by eligibility match, proximity (if zip provided), phase
4. Output shortlist with trial ID, title, phase, key eligibility, contact

**Note:** Criteria entered by clinician must be de-identified. Skill prompts for confirmation.

### 4.4 `/visit-prep` — Patient Visit Preparation Checklist

**Trigger:** `/visit-prep <appointment_type> [condition]`
**Steps:**
1. Look up visit type requirements (from local knowledge base + NCI guidelines)
2. Generate patient-facing checklist: what to bring, what to do before, what questions to ask
3. Optionally: cross-check against known treatment guidelines for that condition
4. Output: plain-language checklist in patient-friendly reading level (Grade 8)

**This directly addresses the cancer patient coordination problem identified.**

---

## Phase 5 — POC Integration & Demo
**Goal:** End-to-end demonstrable workflow for cancer patient coordination
**Duration:** ~1 week
**Exit criteria:** Demo-ready for pilot institution

### 5.1 Cancer Patient Coordination Workflow

Full scenario demonstrating the problems identified:

```
Clinician: /visit-prep oncology-followup breast-cancer-stage-2
→ Agent generates: what patient brings, what labs needed, what imaging to confirm

Clinician: /drug-check tamoxifen, anastrozole, ibuprofen, sertraline
→ Agent returns: interaction report with severity levels

Researcher: /lit-review SGLT2 inhibitors cardiovascular outcomes in diabetic patients
→ Agent returns: structured evidence summary with citations

Care coordinator: /trial-match breast cancer stage 2 ER-positive
→ Agent returns: ranked open trials with eligibility assessment
```

### 5.2 Batch Mode Demo

```bash
# Nightly literature digest for oncology team
echo '{"prompt": "/lit-review new breast cancer treatment 2024-2025"}' | \
  healthagent -p --input-format stream-json --output-format stream-json \
  >> /var/log/healthagent/daily_digest.jsonl
```

### 5.3 Server Mode Demo (multi-user)

```bash
# Start for small team
healthagent server --port 8080 --max-sessions 10 --auth-token $INSTITUTION_TOKEN
```

### 5.4 Audit Log Review

```bash
# Show today's audit trail
cat ~/.healthagent/audit/$(date +%Y-%m-%d).jsonl | jq .

# Check for PHI detection events
grep '"phi_detected":true' ~/.healthagent/audit/*.jsonl
```

---

## What v0.1.0 Is and Is Not

### Is
- On-premise agent runtime with local LLM
- 5 clinical data tools (PubMed, trials, drugs, coding, guidelines)
- 4 clinical workflows (lit review, drug check, trial match, visit prep)
- PHI scanner + local audit log
- Batch mode and server mode functional
- Demonstrable cancer patient coordination scenario

### Is Not
- EHR integrated (Phase 2 product)
- FDA cleared or HIPAA certified (requires formal compliance process)
- Patient-facing (clinician/researcher tool only)
- Voice-enabled
- Web UI (CLI and server API only)

---

## Repository Structure (Target)

```
healthagent/
├── src/                          # Modified Claude Code source
│   ├── services/
│   │   └── api/client.ts         # Local model client added
│   └── utils/
│       ├── auth.ts               # Simplified (OAuth removed)
│       └── hooks/                # PHI scanner + audit logger
├── mcp/                          # Clinical MCP servers (new)
│   ├── pubmed/
│   ├── trials/
│   ├── drugs/
│   ├── coding/
│   └── guidelines/
├── skills/                       # Clinical skills (new)
│   ├── lit-review.md
│   ├── drug-check.md
│   ├── trial-match.md
│   └── visit-prep.md
├── config/
│   ├── mcp_servers.json          # MCP server registry
│   └── CLAUDE.md                 # Healthcare system prompt
├── scripts/
│   └── install.sh                # On-premise setup script
└── HEALTHAGENT_DEV_PLAN.md       # This file
```

---

## Dependencies to Add

```json
{
  "openai": "^4.x",
  "axios": "^1.x",
  "@modelcontextprotocol/sdk": "^1.x"
}
```

The `openai` package is used only as an OpenAI-compatible HTTP client to talk to local Ollama/vLLM — not for OpenAI API access.

---

## Phase Summary

| Phase | Work | Duration | Deliverable |
|-------|------|----------|-------------|
| 0 — Strip & Harden | Remove telemetry, OAuth, external deps | 1 week | Clean local-only base |
| 1 — Compliance Layer | PHI scanner, audit log, consent gate | 1 week | Every action logged, PHI flagged |
| 2 — Local Model | OpenAI-compatible client, Ollama/vLLM | 3–5 days | Runs on Llama 3.1 70B |
| 3 — Clinical MCP Servers | 5 MCP servers built and tested | 2 weeks | PubMed, trials, drugs, coding, guidelines |
| 4 — Clinical Skills | 4 skill workflows | 1 week | /lit-review, /drug-check, /trial-match, /visit-prep |
| 5 — POC Demo | Integration, batch mode, server mode | 1 week | Demo-ready for pilot institution |
| **Total** | | **~7 weeks** | **v0.1.0 POC** |

---

## Open Questions Before Starting

1. **Local model hardware** — What GPU is available at the target institution? Determines which model tier is realistic.
2. **Pilot user role** — Clinician? Researcher? Coordinator? Determines which skill to build first (Phase 4).
3. **Pilot institution** — Any EHR vendor constraint that affects Phase 3 scope?
4. **CPT licensing** — Does the institution already have an AMA license? Affects coding MCP server scope.
5. **SNOMED CT** — NLM provides a free US license. Register at nlm.nih.gov before Phase 3.
