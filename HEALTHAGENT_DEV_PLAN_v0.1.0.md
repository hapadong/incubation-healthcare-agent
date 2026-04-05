# HealthAgent v0.1.0 — Development Plan

**Base:** Claude Code v2.1.88 source
**Goal:** Local-first personal clinical assistant — polished CLI, thin web UI
**Target:** Individual clinicians and clinical researchers (not hospital IT deployment)
**Model:** Any OpenAI-compatible API endpoint (local, Azure-hosted, or otherwise org-controlled)
**Status:** Active development — this file tracks v0.1.0 scope only

---

## Deployment Model

**Local-first.** Each user installs the CLI on their own machine. Data never leaves the workstation.
No shared server, no concurrency concerns, no IT approval required.

```
Browser (optional) → localhost:3000 (future web UI) → local ha process → local MCP servers
                                                     ↓
                                              ~/.healthagent/
                                              ├── patients/     patient records
                                              ├── sessions/     conversation history
                                              └── audit/        append-only tool log
```

**Future tiers (not in scope for v0.1.0):**
- Cloud sync: sessions and patient records follow the user across devices
- Enterprise: centralized deployment for hospital teams (requires SSO, HIPAA BAA, IT review)

---

## Guiding Principles

- No patient data touches services outside the workstation — ever
- Compliance is infrastructure, not a feature
- Ship working tools fast; polish later
- Keep the agent runtime intact; replace only the cloud-dependent layers
- Every phase ends with something demonstrable
- No assumptions about institution-specific licenses or infrastructure

---

## Phase 0 — Strip & Harden ✅ DONE
**Goal:** Clean base with no privacy liabilities
**Exit criteria met:** Agent starts, runs, zero external calls except to configured model endpoint

### 0.1 Remove Telemetry ✅
Removed `src/services/analytics/`, all `logAnalyticsEvent()` / `trackEvent()` call sites,
Datadog sink, and usage tracking that reported upstream.

### 0.2 Remove Claude.ai OAuth ✅
Removed OAuth service, login/logout commands, OAuth config, macOS Keychain dependency,
and all subscription checks. Replaced with single env var `HEALTHAGENT_API_KEY`.

### 0.3 Remove External-Dependent Features ✅
Removed: remote triggers, GitHub commands, Anthropic update/upgrade, bridge/coordinator/teleport,
internal Anthropic-only commands (~40 total), cloud SDK branches (Bedrock, Vertex, Foundry).

### 0.4 Model API Abstraction Layer ✅

```
HEALTHAGENT_API_BASE_URL=https://your-model-endpoint/v1
HEALTHAGENT_API_KEY=your-key
HEALTHAGENT_DEFAULT_MODEL=your-model-name
HEALTHAGENT_FAST_MODEL=your-fast-model-name
```

Single OpenAI-compatible client path. Works with Ollama, vLLM, Azure OpenAI, or any compliant endpoint.

---

## Phase 1 — Compliance Layer ✅ DONE
**Goal:** Prevent PHI from leaking to external services + append-only audit trail
**Exit criteria met:**
- External tool calls scanned for structural PHI (SSN, email, phone) — blocks on detection
- De-identification instruction hardcoded in system prompt
- JSONL audit log at `~/.healthagent/audit/YYYY-MM-DD.jsonl` — confirmed working
- All agents in session covered by session-level hook registration

### Design principle

Hospital staff know their own PHI obligations. The one gap this layer fills: when the agent
makes external calls (web search, public APIs), PHI can leak out silently.

**PHI stays within the authorized perimeter:**
```
Authorized perimeter: local model + local MCP servers + audit log + workstation
    → PHI allowed to flow freely inside

External calls: WebSearch, WebFetch, public MCP servers (PubMed, trials, drugs)
    → PHI must not appear in queries sent to these
```

### 1.1 External PHI Guard (PreToolUse hook)
**File:** `src/utils/healthagent/complianceHooks.ts`

Two-layer detection:
1. CLAUDE.md behavioral instruction — agent de-identifies before external calls
2. Backstop regex for structured identifiers only (SSN, email, US phone)

On detection: block call, show message, log to audit trail.

### 1.2 Local Audit Logger (PostToolUse)
**File:** `src/utils/healthagent/auditLogger.ts`

Append-only `~/.healthagent/audit/YYYY-MM-DD.jsonl`. Inputs hashed (sha256), never stored raw.

### 1.3 Consent Gate
One-line notice once per day on interactive session start. Skipped in headless mode.

---

## Phase 2 — Clinical MCP Servers ✅ DONE
**Goal:** Pre-built clinical data tools, all free/open APIs, no per-institution licenses
**Exit criteria met:** 6 MCP servers functional (pubmed, trials, drugs, coding, guidelines, mimic)

### MCP Servers

| Server | API | Tools |
|--------|-----|-------|
| pubmed | NCBI E-utilities (free) | search, fetch, related |
| trials | ClinicalTrials.gov v2 (free) | search, detail |
| drugs | OpenFDA + RxNorm + DailyMed (free) | lookup, interactions, rxnorm, adverse_events, recalls |
| coding | CMS ICD-10 + LOINC via NLM (free) | icd10_search, loinc_search |
| guidelines | NCI PDQ + USPSTF (free) | guidelines_search, health_topic |
| mimic | MIMIC-IV local DB | cohort, patient, labs, icu, sql |
| patients | Local disk `~/.healthagent/patients/` | list, load, save, update, generate_id |

### Patient Record Schema (v1 — current)

Schema aligned with IPS (International Patient Summary) FHIR R4.
Not a conformant FHIR resource — simplified flat JSON for LLM consumption.

**Reference:** `http://hl7.org/fhir/uv/ips/` STU2 (2024), FHIR R4 (4.0.1)

| Field | FHIR mapping | Notes |
|-------|-------------|-------|
| demographics | Patient (R4) | age, gender, dob, race, language |
| diagnoses | Condition (R4) | + status (active/resolved/chronic), onset_date |
| medications | MedicationStatement (R4) | + status (active/discontinued/on-hold), start/end dates |
| allergies | AllergyIntolerance (R4) | substance, type, severity, reaction — **new in v1** |
| labs | Observation (R4) | label, value, unit, reference_range, flag, time |
| vitals | Observation:vital-signs (R4) | bp, hr, temp, rr, spo2, weight, height, bmi — **new in v1** |
| procedures | Procedure (R4) | description, code, code_system, date, status — **new in v1** |
| social_history | Observation:social-history (R4) | smoking, alcohol, occupation — **new in v1** |
| icu | Encounter (R4) | ICU stay summary |

**Schema versioning:** Every record carries `schema_version` (current: 1). Old v0 records are
migrated forward automatically on first load — no manual migration needed.

---

## Phase 3 — Clinical Skills ✅ DONE
**Goal:** Workflow-level behaviors composing the MCP tools
**Exit criteria met:** 4 skills working end-to-end

### Skills

- `/lit-review <question>` — PICO-structured PubMed review with evidence level tags
- `/drug-check <drug1, drug2, ...>` — Interaction matrix with severity + recall alerts
- `/trial-match <condition> [filters]` — Trial search with eligibility assessment
- `/visit-prep <visit_type> [condition]` — Pre-visit checklist in plain language

---

## Phase 4 — Session Stability & Resume ✅ DONE
**Goal:** Reliable session persistence and resume across days
**Exit criteria met:** `ha --resume <uuid>` loads full conversation history with scroll

### Fixes shipped

- **Cross-day resume:** Sessions date-bucketed in `~/.healthagent/sessions/YYYY-MM-DD/`.
  Index file (`index.json`) enables O(1) lookup; directory scan fallback for pre-index sessions.
- **parentUuid chain repair:** Typeless entries in JSONL were resetting the parentUuid cursor,
  causing all assistant messages to be written with `parentUuid=null`. Fixed in write path
  (`isLoggableMessage`, `insertMessageChain`) and repaired on load (`repairOrphanedAssistants`).
- **MCP tool render on resume:** `findToolByName` crash fixed with optional chaining.
  MCP "not found" log noise suppressed — MCP servers connect asynchronously after startup.
- **Config isolation:** All HealthAgent config redirected to `~/.healthagent/` via
  `CLAUDE_CONFIG_DIR`. Debug logs, session store, audit log, patients all colocated.

---

## Phase 5 — Patient Summary & Analytics ✅ DONE
**Goal:** Accurate structured patient data as foundation for all clinical tasks
**Exit criteria met:** Patient schema v1 with FHIR alignment; MIMIC analytics MCP server

### Why patient summary is the foundation

Every clinical task depends on accurate patient data:
- Drug checks need **allergies** — contraindications missed without them
- Trial matching needs **diagnosis status** — active vs. resolved changes eligibility
- Visit prep needs **vitals** — incomplete without recent BP/weight/HR
- Literature review needs **diagnosis context** — drives the clinical question

Patient summary accuracy is the single biggest lever on output quality.

---

## Phase 6 — Restorable Features (Planned)
**Goal:** Restore high-value features removed in Phase 0, replacing Claude-specific backends
**Priority order based on clinical utility and implementation effort**

### 6.1 Session Auto-Naming *(trivial effort)*

`generateSessionName` called `queryHaiku` to name sessions from conversation text.
Replace with a call to the configured Azure OpenAI endpoint. The `title` field in
`SessionMeta` is already defined and waiting.

**Impact:** Makes session list in CLI and future web UI usable at a glance.
**Effort:** ~2 hours.

### 6.2 `/rewind` — Message Selector *(essentially free)*

Opens a message selector UI — lets the user jump back to any previous message.
Had zero Anthropic API dependency. Just needs the command re-registered.

**Impact:** Lets clinicians backtrack within a session without losing context.
**Effort:** ~30 minutes.

### 6.3 Voice Input *(DEFERRED — cross-platform dependency problem)*

UI skeleton remains: `src/context/voice.tsx`, `VoiceIndicator.tsx`, `VoiceModeNotice.tsx`,
`useVoiceIntegration.tsx`, `voiceKeyterms.ts`. The STT backend (`voiceStreamSTT.js`) is
a dead stub pointing to Anthropic's private WebSocket.

**Why deferred:** Local Whisper is the right backend (audio must not leave the machine for
clinical use), but it requires SoX for audio capture + whisper.cpp or Python Whisper CLI —
each with different install paths on macOS, Windows, and Linux. Bundling adds ~200MB and
significant packaging complexity. Prerequisite-based approach works on macOS but is messy
on Windows. Not worth the cross-platform maintenance burden until voice is validated as a
feature users actually need.

**Revisit when:** Early users on macOS confirm they want voice AND the user base is
predominantly macOS. At that point, ship macOS-only with a Homebrew install requirement
(`brew install sox`) and gate with a clear "macOS only" notice.

### 6.4 Away Summary *(small effort)*

After 5 minutes of terminal blur, generates a "while you were away" summary of what
the agent did. Had a GrowthBook feature flag — needs gate removed, backend swapped to
Azure OpenAI.

**Impact:** Clinician steps away mid-session, comes back to a summary of what happened.
**Effort:** ~4 hours.

### 6.5 Multi-Agent / Swarm *(large effort, deferred)*

Spawned sub-agents as separate processes (iTerm2, tmux, or in-process backends).
Model fallback referenced Opus but was just a string — fully swappable. No hard
Anthropic API dependency in the spawn/coordination logic.

**Clinical value:** Parallel clinical workflows — one agent researches trials while
another runs a drug check. Useful for complex multi-condition patients.
**Effort:** Large. Defer post-v0.1.0.

---

## Phase 7 — Local Web UI (Planned)
**Goal:** Browser interface over the local CLI — same capabilities, better UX
**Deployment:** Each user runs `ha web` locally. Browser talks to localhost. No auth needed.

```
ha web --port 3000
```

### Architecture

```
Next.js (localhost:3000)
  ├── GET  /api/sessions          → read ~/.healthagent/sessions/index.json
  ├── GET  /api/sessions/:id      → parse JSONL transcript
  ├── POST /api/chat              → spawn/pipe to local ha process
  └── GET  /api/chat/stream       → SSE stream of ha stdout
```

The web server is a thin shell. All capabilities (tool execution, MCP integration,
conversation memory, patient store) remain in the CLI — zero duplication.

### What the UI handles
- Session list (read from existing index.json — already structured for this)
- Chat rendering (parse JSONL, display messages)
- Send message (pipe to local ha process, stream response via SSE)
- `/command` translation (intercept `/patient list` → natural language or direct MCP call)

### What does NOT change
The CLI remains the primary interface and source of truth. Every CLI improvement
automatically appears in the web UI. The web UI is purely a display/input layer.

### Not in scope for local web UI
- Authentication (single-user local tool, no auth needed)
- Multi-user (each clinician runs their own instance)
- Cloud sync (future premium tier)

---

## Batch Mode — Deferred
**Decision:** Batch mode deferred until patient data integration matures.

Most batch scenarios require structured patient data feeding in to be useful.
The one genuine use case (drug interaction sweep across patient panel) is feasible
with the current patient store, but not a priority for v0.1.0.

Batch mode becomes meaningful when:
1. Patient list has structured data feeding in (patient store already supports this)
2. Output goes somewhere actionable — a flagged report, not a JSONL file

---

## What v0.1.0 Is and Is Not

### Is
- Local-first personal clinical assistant
- Agent runtime with configurable OpenAI-compatible model endpoint
- 6 clinical MCP servers (PubMed, trials, drugs, coding, guidelines, MIMIC-IV)
- Patient persistence with FHIR-aligned schema v1 (IPS R4)
- 4 clinical skills (lit review, drug check, trial match, visit prep)
- PHI scanner + local append-only audit log
- Reliable session persistence and cross-day resume
- All data sources free/open — no per-institution licenses required

### Is Not
- EHR integrated
- FDA cleared or formally HIPAA certified
- Patient-facing (clinical team tool only)
- CPT-enabled (proprietary AMA license — optional add-on in future)
- Multi-user or centralized (local-first only in v0.1.0)
- Voice-enabled (planned Phase 6)
- Web UI (planned Phase 7)

---

## Deployment Tiers (Roadmap)

| Tier | Who | Architecture | Status |
|------|-----|-------------|--------|
| Local CLI | Individual clinician, researcher | `ha` on personal machine | v0.1.0 |
| Local Web UI | Same user, browser preference | `ha web` on personal machine | Phase 7 |
| Cloud Sync | Individual, multi-device | Local + optional sync to personal DB | Future |
| Enterprise | Hospital team | Centralized server, SSO, HIPAA BAA | Future |

The architecture evolves without breaking earlier tiers. The session store abstraction
(`HealthAgentSessionStore` interface + `HEALTHAGENT_SESSION_BACKEND` env var) is
already designed for backend swap when cloud sync lands.

---

## Repository Structure

```
healthagent/
├── src/                               # Runtime source
│   └── utils/healthagent/
│       ├── phiScanner.ts              # PHI regex patterns
│       ├── auditLogger.ts             # Append-only JSONL audit writer
│       ├── complianceHooks.ts         # PreToolUse/PostToolUse registration
│       └── sessionStore.ts            # Session index + date-bucket store
├── mcp/                               # Clinical MCP servers
│   ├── pubmed/
│   ├── trials/
│   ├── drugs/
│   ├── coding/
│   ├── guidelines/
│   ├── mimic/
│   └── patients/                      # Schema v1 — FHIR IPS aligned
├── skills/                            # Clinical skill templates
│   ├── lit-review.md
│   ├── drug-check.md
│   ├── trial-match.md
│   └── visit-prep.md
└── config/
    ├── mcp_servers.json               # MCP registry
    └── CLAUDE.md                      # Healthcare system prompt + PHI rules
```

---

## Phase Summary

| Phase | Work | Status |
|-------|------|--------|
| 0 — Strip & Harden | Remove telemetry, OAuth, Anthropic deps; model API abstraction | ✅ Done |
| 1 — Compliance Layer | PHI guardrail, de-id system prompt, audit log | ✅ Done |
| 2 — Clinical MCP Servers | 6 servers, all free APIs, patient schema v1 | ✅ Done |
| 3 — Clinical Skills | 4 skill workflows | ✅ Done |
| 4 — Session Stability | Cross-day resume, parentUuid repair, config isolation | ✅ Done |
| 5 — Patient Summary | FHIR-aligned schema v1, allergies/vitals/procedures | ✅ Done |
| 6 — Restorable Features | Session naming, rewind, voice, away summary | Planned |
| 7 — Local Web UI | Next.js thin shell over local CLI | Planned |
