# HealthAgent v0.3.0 — Development Plan

**Base:** HealthAgent v0.2.0
**Goal:** Workflow runner — declarative YAML pipelines that execute multi-step, multi-agent
clinical workflows over parameterized inputs, producing structured output for downstream systems
**Status:** Planning

---

## Problem Statement

v0.1.0 and v0.2.0 serve interactive use: a clinician asks questions, the agent responds. But
clinical research has a second workload — **batch processing**:

- Run oncology team review for 50 patients before morning rounds
- Nightly cohort analysis: find MIMIC patients matching an ICD criteria, summarize labs for each
- Weekly literature digest: scan PubMed for new papers on 10 active drug candidates
- Audit prep: generate coding summaries for all visits in a date range

Interactive tools cannot serve this cleanly. The missing pieces are:

1. **Declarative workflow definition** — describe what to run, not how
2. **Parameterized inputs** — drive execution from a patient list, CSV, or JSON
3. **Structured output** — JSON/CSV for dashboards or EHRs, not chat transcripts
4. **Parallelism with rate control** — N items concurrently without hitting API limits
5. **Resumability** — pick up a failed run from where it stopped
6. **Full audit trail** — same PHI compliance as interactive sessions

---

## Design Decisions

### One binary, not three

`ha run` is a new **subcommand** of the existing CLI — not a new binary. The web server gains
`POST /api/workflow` when the runner is complete.

```
ha                          # interactive CLI (v0.1.0)
ha-web                      # web server  (v0.2.0)
ha run <workflow.yaml>      # workflow runner (v0.3.0) — same ha binary
```

### Engine factory is the foundation

`createEngineSession()` from `engineFactory.ts` is called once per workflow item. The agent loop,
MCP connections, tool pool, PHI scanner, and audit hooks are inherited with zero duplication.

### Sequential steps, parallel items

Within one item, steps run **sequentially** — each step can reference prior step outputs.
Across items, execution is **parallel** up to a concurrency limit, throttled by a rate limiter.

```
items: [patient_001 … patient_050]
               ↓  p-map (concurrency=3)
  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
  │ patient_001 │ │ patient_002 │ │ patient_003 │
  │   step 1   │ │   step 1   │ │   step 1   │
  │   step 2   │ │   step 2   │ │   step 2   │
  │   step 3   │ │   step 3   │ │   step 3   │
  └─────────────┘ └─────────────┘ └─────────────┘
        ↓               ↓               ↓
  results/run-id/patient_001.json  …  patient_003.json
```

### Structured output via extraction step

The agent loop produces natural language. A configurable extraction step converts each step's
output to structured JSON via a focused second prompt. This keeps structured output decoupled
from the skill implementations themselves — no changes to any existing skill.

---

## Workflow YAML Schema

```yaml
# ── Metadata ──────────────────────────────────────────────────────────────────
name: oncology_team_review
version: "1.0"
description: Run full oncology team review for a list of patients

# ── Input ─────────────────────────────────────────────────────────────────────
input:
  type: csv                  # csv | json | jsonl | inline
  path: patients.csv         # relative to workflow file or absolute
  key_field: patient_id      # column used as the unique item identifier
  # Inline alternative (for testing):
  # type: inline
  # items:
  #   - { patient_id: "10006", diagnosis: "NSCLC" }

# ── Execution ─────────────────────────────────────────────────────────────────
concurrency: 3               # parallel items (default: 1)
timeout_per_item: 300        # seconds across all steps for one item (default: 300)
retry:
  max_attempts: 2            # per-item retries on failure (default: 1 = no retry)
  backoff: exponential       # exponential | fixed

# ── Steps (sequential within each item) ───────────────────────────────────────
steps:
  - id: summary
    name: Patient Summary
    skill: /patientSummary   # use a built-in skill; OR use prompt: for free-form
    prompt: "Summarize the clinical record for patient {{ item.patient_id }}"
    output:
      mode: text             # text | json

  - id: trials
    name: Trial Matching
    skill: /trialMatch
    prompt: |
      Find matching clinical trials for this patient:
      {{ steps.summary.text }}
    output:
      mode: json
      extract_fields:
        - name: matched_trials
          type: array
          description: List of matched trial NCT IDs and titles
        - name: eligibility_summary
          type: string
          description: One-paragraph eligibility assessment

  - id: team_review
    name: Oncology Team Review
    prompt: |
      Facilitate an oncology tumor board for this patient.

      Patient summary:
      {{ steps.summary.text }}

      Trial options:
      {{ steps.trials.text }}

      Provide a structured consensus recommendation.
    output:
      mode: json
      extract_fields:
        - name: primary_recommendation
          type: string
        - name: treatment_options
          type: array
        - name: next_steps
          type: array
        - name: follow_up_timeline
          type: string

# ── Output ────────────────────────────────────────────────────────────────────
output:
  format: json               # json | jsonl | csv
  directory: results/        # relative to workflow file
  fields:                    # columns in aggregated output file
    - item.patient_id
    - steps.summary.text
    - steps.trials.json.matched_trials
    - steps.trials.json.eligibility_summary
    - steps.team_review.json.primary_recommendation
    - steps.team_review.json.treatment_options
    - steps.team_review.json.next_steps
```

### Template variables

| Variable | Value |
|---|---|
| `{{ item.<field> }}` | Column from input CSV/JSON for the current item |
| `{{ steps.<id>.text }}` | Full text output of a completed prior step |
| `{{ steps.<id>.json.<field> }}` | Extracted JSON field from a prior step |
| `{{ run.id }}` | UUID of the current run |
| `{{ run.timestamp }}` | ISO timestamp of run start |
| `{{ item.__key }}` | Value of the `key_field` column |

---

## Run Manifest

Every run produces a manifest at `results/<run-id>/manifest.json`, written incrementally
after each item completes (safe to inspect a running job):

```json
{
  "run_id": "a3f2c1d9-...",
  "workflow": "oncology_review.yaml",
  "workflow_version": "1.0",
  "started_at": "2026-04-28T09:00:00Z",
  "completed_at": "2026-04-28T09:43:12Z",
  "status": "partial",
  "concurrency": 3,
  "total": 50,
  "succeeded": 47,
  "failed": 3,
  "skipped": 0,
  "items": {
    "patient_001": {
      "status": "success",
      "duration_ms": 18420,
      "output_file": "results/a3f2c1d9/patient_001.json",
      "steps": {
        "summary":     { "status": "success", "duration_ms": 4100 },
        "trials":      { "status": "success", "duration_ms": 7340 },
        "team_review": { "status": "success", "duration_ms": 6980 }
      }
    },
    "patient_012": {
      "status": "failed",
      "error": "Timeout after 300s at step: trials",
      "attempts": 2
    }
  }
}
```

---

## CLI Interface

```bash
# Run a workflow
ha run oncology_review.yaml --input patients.csv

# Override output directory
ha run oncology_review.yaml --input patients.csv --output /data/runs/

# Override concurrency at runtime
ha run oncology_review.yaml --input patients.csv --concurrency 5

# Dry run: validate YAML + templates, print execution plan, do not call APIs
ha run oncology_review.yaml --input patients.csv --dry-run

# Resume a partial run (skips items where manifest shows status: success)
ha run oncology_review.yaml --resume a3f2c1d9

# Run only specific items (for debugging)
ha run oncology_review.yaml --input patients.csv --item patient_012

# Validate a workflow file without running
ha workflow validate oncology_review.yaml

# List past runs (reads results/ directory)
ha workflow list

# Show status of a specific run
ha workflow status a3f2c1d9
```

---

## Architecture

```
ha run workflow.yaml --input patients.csv
          |
    WorkflowRunner.run()
          |
    inputReader.load()          --> [ {patient_id: "001"}, ... ]
    manifest.loadOrCreate()     --> RunManifest (resume state)
          |
    p-map(items, concurrency=N)
          |  (per item)
    rateLimiter.acquire()
    createEngineSession({ cwd })     <-- shared engine factory (no duplication)
          |
    for each step:
        template.render(prompt, { item, steps, run })
        ask({ prompt, ...engineSession })   <-- same agent loop as CLI/web
        |
        if step.output.mode === 'json':
            extractor.extract(stepText, fields)  <-- focused second ask()
        |
        steps[id] = { text, json }
          |
    manifest.markItem(key, status, steps)   --> results/<run-id>/manifest.json
    outputWriter.writeItem(key, fields)     --> results/<run-id>/<key>.json
          |
    manifest.finalize()
    outputWriter.aggregate()               --> results/<run-id>/all.json
```

### New files

```
src/
└── workflow/
    ├── schema.ts       TypeScript types: WorkflowDef, StepDef, InputDef, OutputDef, RunManifest
    ├── parser.ts       YAML loader + schema validation (uses existing yaml dep)
    ├── template.ts     {{ }} template engine — item, steps, run variable resolution
    ├── extractor.ts    Structured output extraction (runs a second focused ask() per step)
    ├── runner.ts       WorkflowRunner class — orchestrates p-map, steps, manifest, output
    ├── manifest.ts     Read/write manifest.json; resume state lookup
    ├── rateLimiter.ts  Token-bucket rate limiter (requests/min cap + backoff on 429)
    ├── inputReader.ts  CSV / JSON / JSONL / inline input adapters
    ├── outputWriter.ts Per-item JSON writer + aggregated results file
    └── index.ts        Public exports

src/entrypoints/cli.tsx     Add ha run subcommand (modify existing)
src/entrypoints/web.ts      Add POST /api/workflow + GET /api/workflow/:runId (phase 8.7)
```

Files **not** changed: `QueryEngine.ts`, `tools/`, `services/mcp/`, `utils/healthagent/`,
`shared/engineFactory.ts`, all existing MCP servers and skills.

---

## Structured Output Extraction

The extractor fires a second, focused prompt after any step with `mode: json`:

```
System: You are a precise data extractor. Extract the requested fields from the
        provided clinical text as valid JSON. Output only the JSON object — no
        prose, no markdown fences.

User:   Extract the following fields:
        - matched_trials (array): list of matched trial NCT IDs and titles
        - eligibility_summary (string): one-paragraph eligibility assessment

        Source text:
        <agent step output>
```

If the extraction fails JSON.parse, the runner retries once with an explicit correction prompt
before marking the step as `extraction_failed` and falling back to `text` mode.

---

## Rate Limiter

A token-bucket limiter sits in front of every `ask()` call in the runner:

```typescript
// Configurable via env or workflow yaml
HEALTHAGENT_BATCH_RPM=20      // requests per minute (default: 20)
HEALTHAGENT_BATCH_TPM=80000   // tokens per minute (default: 80000, conservative)
```

On HTTP 429 from the API, the runner backs off exponentially (2s → 4s → 8s → …) up to
`retry.max_attempts`. This is separate from the per-item retry — a rate-limit backoff does not
consume a retry attempt.

---

## PHI Considerations for Batch

Batch processing introduces new PHI surface areas not present in interactive use:

| Surface | Risk | Mitigation |
|---|---|---|
| Input CSV/JSON | May contain patient names, DOBs, MRNs | Recommend opaque IDs only (`patient_id`, not `patient_name`). Validate `key_field` is not a direct identifier. Warn on fields matching PHI patterns. |
| Templates | `{{ item.name }}` would inject PHI into prompts | PHI scanner PreToolUse hook still fires on every external tool call. Cannot intercept template rendering itself — document limitation. |
| Output files | Results written to local disk | Results inherit the same local-first constraint. Output directory should be outside version control. |
| Manifest | Item keys are logged | Use opaque IDs as `key_field`. Manifest is written to `~/.healthagent/audit/` summary alongside per-run results. |
| Audit log | `session_id` per item | Each item gets a fresh `createEngineSession()` → unique session ID → correct per-item audit entries. No concurrent-session ID race (unlike web). |

Batch mode is the **cleanest audit path** because each item has its own isolated engine session.

---

## Web API (Phase 8.7)

```
POST /api/workflow
  Body: { workflowYaml: string, input: object[], options?: { concurrency, dryRun } }
  Response: { runId: string }

GET /api/workflow/:runId
  Response: RunManifest (same structure as manifest.json)

GET /api/workflow/:runId/stream
  SSE: progress events per item { itemKey, status, stepId, message }

GET /api/workflow/:runId/results
  Response: aggregated results JSON (same as results/<run-id>/all.json)

DELETE /api/workflow/:runId
  Aborts an in-progress run, cleans up session
```

---

## Detailed Task List

### Phase 8.1 — Workflow Schema & Parser

**Goal:** Define and validate the workflow YAML format.

- [ ] **8.1.1** Write `src/workflow/schema.ts` — TypeScript types for all workflow config objects
- [ ] **8.1.2** Write `src/workflow/parser.ts`:
  - Load YAML using existing `yaml` dependency
  - Validate required fields (name, input.type, steps, output.format)
  - Validate step IDs are unique and referenced step IDs in templates exist
  - Return typed `WorkflowDef` or structured validation errors
- [ ] **8.1.3** Write `src/workflow/template.ts`:
  - Parse `{{ variable }}` expressions
  - Resolve `item.*`, `steps.<id>.text`, `steps.<id>.json.*`, `run.*`
  - Throw on undefined variable reference (fail-fast, surface in dry-run)
- [ ] **8.1.4** Test: parse the oncology_review.yaml example, assert no validation errors
- [ ] **8.1.5** Test: template renders correctly with mock item + step data

### Phase 8.2 — Input Reader

**Goal:** Load parameterized input from CSV, JSON, JSONL, or inline config.

- [ ] **8.2.1** Write `src/workflow/inputReader.ts`:
  - `csv` adapter: parse CSV, validate `key_field` column exists, return array of row objects
  - `json` adapter: load JSON array, validate `key_field` exists on each item
  - `jsonl` adapter: stream JSONL lines into array
  - `inline` adapter: use `input.items` from workflow YAML directly
- [ ] **8.2.2** PHI field detection: warn (not block) if any column name matches a known PHI
  pattern (name, dob, ssn, mrn, phone, email, address)
- [ ] **8.2.3** Test: load a 3-row CSV, verify correct array output and key extraction

### Phase 8.3 — Structured Output Extractor

**Goal:** Convert agent text output to structured JSON for steps with `mode: json`.

- [ ] **8.3.1** Write `src/workflow/extractor.ts`:
  - Build extraction prompt from `extract_fields` list
  - Call `ask()` with a focused system prompt (extractor persona, JSON-only output)
  - Parse JSON from response, validate field names match schema
  - On parse failure: retry once with correction prompt
  - On second failure: return `{ __extraction_failed: true, raw: stepText }`
- [ ] **8.3.2** Test: run extractor against a sample trial match output, verify NCT IDs extracted
- [ ] **8.3.3** Test: simulate malformed JSON response, verify graceful fallback

### Phase 8.4 — Manifest & Output Writer

**Goal:** Persist run state incrementally so runs are resumable and inspectable mid-flight.

- [ ] **8.4.1** Write `src/workflow/manifest.ts`:
  - `create(runId, workflowDef, totalItems)` — initialise manifest file
  - `load(runId)` — load existing manifest for resume
  - `markItem(key, status, steps, durationMs)` — atomic append to manifest
  - `finalize(runId)` — write final counts and `completed_at`
  - `getSucceeded(runId)` — return Set of item keys already succeeded (for resume)
- [ ] **8.4.2** Write `src/workflow/outputWriter.ts`:
  - `writeItem(runDir, key, fields, stepResults)` — write per-item JSON
  - `aggregate(runDir, format)` — merge all per-item files into `all.json` / `all.csv`
- [ ] **8.4.3** Test: write 3 items, verify manifest and per-item files, aggregate correctly
- [ ] **8.4.4** Test: simulate resume — mark item 1 succeeded, runner skips it

### Phase 8.5 — Rate Limiter

**Goal:** Prevent API rate limit errors in concurrent batch runs.

- [ ] **8.5.1** Write `src/workflow/rateLimiter.ts`:
  - Token-bucket implementation: `rpm` and `tpm` buckets
  - `acquire(estimatedTokens?)` — async, waits until token available
  - `onRateLimitError()` — exponential backoff signaller
  - Configurable via `HEALTHAGENT_BATCH_RPM` / `HEALTHAGENT_BATCH_TPM` env vars
- [ ] **8.5.2** Test: simulate 10 concurrent requests at RPM=5, verify max 5/min throughput

### Phase 8.6 — WorkflowRunner Core

**Goal:** Orchestrate the full pipeline — input → steps → output → manifest.

- [ ] **8.6.1** Write `src/workflow/runner.ts` — `WorkflowRunner` class:
  - `run(workflowDef, options)` → `RunResult`
  - Load input via `inputReader`
  - Load/create manifest (check resume)
  - p-map over items at configured concurrency
  - Per item: rate-limit acquire → engine session → step loop → extract → write → manifest update
  - Abort signal propagation: `Ctrl-C` gracefully finishes in-flight items, writes partial manifest
  - Emit progress events (for CLI display and web SSE)
- [ ] **8.6.2** Dry-run mode: validate templates against first item, print execution plan, exit
- [ ] **8.6.3** Test (sequential): run 3-item inline workflow end-to-end, verify output files
- [ ] **8.6.4** Test (parallel): run 5-item workflow at concurrency=3, verify correct manifest counts
- [ ] **8.6.5** Test (resume): fail item 3 deliberately, resume run, verify items 1-2 skipped

### Phase 8.7 — CLI Integration

**Goal:** Expose workflow runner as `ha run` subcommand with full UX.

- [ ] **8.7.1** Add `run` subcommand to `src/entrypoints/cli.tsx` (or `src/cli/handlers/`):
  - Args: `<workflow-file>` (positional)
  - Options: `--input`, `--output`, `--concurrency`, `--resume <run-id>`, `--item <key>`,
    `--dry-run`
- [ ] **8.7.2** Add `workflow` subcommand group:
  - `ha workflow validate <file>` — parse + template check, print errors or "OK"
  - `ha workflow list` — read `results/` dir, print run table (id, workflow, date, status, counts)
  - `ha workflow status <run-id>` — pretty-print manifest
- [ ] **8.7.3** Progress display: live table of item statuses during run (update in place)
- [ ] **8.7.4** End-of-run summary: print counts, output path, run ID, resume command if partial
- [ ] **8.7.5** Test: `ha workflow validate oncology_review.yaml` passes clean
- [ ] **8.7.6** Test: `ha run` end-to-end with 3-patient inline input

### Phase 8.8 — Web API

**Goal:** Expose workflow execution from the web UI (trigger, monitor, download results).

- [ ] **8.8.1** Add routes to `src/entrypoints/web.ts`:
  - `POST /api/workflow` — accept workflow YAML body + input array, start run async
  - `GET /api/workflow/:runId` — return manifest JSON
  - `GET /api/workflow/:runId/stream` — SSE progress events from runner
  - `GET /api/workflow/:runId/results` — return aggregated results JSON
  - `DELETE /api/workflow/:runId` — abort run
- [ ] **8.8.2** Add basic Workflow UI to `src/web/app.tsx`:
  - "Run Workflow" tab in sidebar (upload YAML + input CSV)
  - Progress view: item table with live status updates via SSE
  - Results download button
- [ ] **8.8.3** Test: upload oncology_review.yaml via browser, verify SSE progress stream

### Phase 8.9 — Compliance & Testing

**Goal:** Confirm batch sessions are fully covered by PHI scanner + audit log.

- [ ] **8.9.1** Verify each item's engine session gets a unique session ID in audit log
- [ ] **8.9.2** Verify PHI scanner PreToolUse hook fires correctly in concurrent item execution
- [ ] **8.9.3** Add PHI field detection warning to input reader (8.2.2 above)
- [ ] **8.9.4** Document batch-specific PHI guidance in a `WORKFLOW_PHI_GUIDE.md`
- [ ] **8.9.5** End-to-end test: run 3-patient workflow against MIMIC, verify 3 audit entries

---

## Known Challenges & Mitigations

| Challenge | Severity | Mitigation |
|---|---|---|
| Structured output reliability | High | Extraction retry + graceful fallback to raw text; never block the run |
| API rate limits under concurrency | High | Token-bucket limiter + exponential backoff on 429; configurable RPM/TPM caps |
| Prompt injection via templates | Medium | Templates render before PHI scanner fires; document that `key_field` must be opaque ID |
| Memory with large input files | Medium | Stream JSONL inputs; process items lazily rather than loading all into array |
| Long-running runs (hours) | Medium | Incremental manifest writes; Ctrl-C graceful shutdown; `--resume` covers restart |
| MCP server connection stability | Medium | `createEngineSession()` per item reconnects; transient MCP errors retry with item |
| Extraction hallucination | Low | Extractor prompt is tightly scoped; on parse failure → fallback, no silent corruption |

---

## What v0.3.0 Is and Is Not

### Is
- Declarative YAML workflow runner for multi-step, multi-agent pipelines
- Parameterized by CSV/JSON input (patient lists, query batches, cohorts)
- Structured JSON/CSV output suitable for downstream systems
- Resumable — partial runs can be continued with `--resume`
- PHI-compliant — each item gets an isolated audit session
- Accessible from both CLI (`ha run`) and web (`POST /api/workflow`)

### Is Not
- A hosted job scheduler (no cron, no queue, no cloud)
- A real-time streaming pipeline (items complete before results are written)
- An EHR integration (output is files, not FHIR resources — that is v0.4.0 territory)
- A visual workflow builder (YAML only in v0.3.0)
- Multi-tenant or access-controlled

---

## Phase Summary

| Phase | Work | Status |
|-------|------|--------|
| 0 — Strip & Harden | Remove telemetry, OAuth, Anthropic deps | ✅ Done |
| 1 — Compliance Layer | PHI guardrail, audit log | ✅ Done |
| 2 — Clinical MCP Servers | 7 servers, all free APIs | ✅ Done |
| 3 — Clinical Skills | 4 skill workflows | ✅ Done |
| 4 — Session Stability | Cross-day resume, parentUuid repair | ✅ Done |
| 5 — Patient Summary | FHIR-aligned schema v1 | ✅ Done |
| 6 — Restorable Features | Session naming, rewind, away summary, team review | ✅ Done |
| 7 — Web UI | Shared engine factory, Hono SSE server, React frontend | ✅ Done |
| 8 — Workflow Runner | YAML pipelines, batch execution, structured output | 🔲 Planning |

### Phase 8 Sub-tasks

| Sub-phase | Work | Status |
|-----------|------|--------|
| 8.1 — Schema & Parser | YAML schema, validation, template engine | 🔲 Todo |
| 8.2 — Input Reader | CSV/JSON/JSONL/inline adapters, PHI field warning | 🔲 Todo |
| 8.3 — Output Extractor | Structured JSON extraction from agent text | 🔲 Todo |
| 8.4 — Manifest & Writer | Incremental state, per-item files, aggregation | 🔲 Todo |
| 8.5 — Rate Limiter | Token-bucket RPM/TPM control, 429 backoff | 🔲 Todo |
| 8.6 — WorkflowRunner Core | p-map orchestration, resume, abort, progress | 🔲 Todo |
| 8.7 — CLI Integration | ha run subcommand, ha workflow commands, progress display | 🔲 Todo |
| 8.8 — Web API | POST /api/workflow, SSE progress, results download, UI | 🔲 Todo |
| 8.9 — Compliance | Per-item audit sessions, PHI guidance, end-to-end tests | 🔲 Todo |
