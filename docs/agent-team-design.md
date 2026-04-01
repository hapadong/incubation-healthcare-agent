# Verity Health Agent — Multi-Agent Team Design

## How the Agent Framework Works (This Repo)

### Core pattern

One **main agent** runs the query loop. It analyzes the user's question, breaks it into subtasks, and delegates to **specialist subagents** via the Agent tool. Subagents can run sequentially or in parallel.

```
User question
    │
    ▼
Main Agent (query loop)
    │  analyzes, routes
    ├──► Subagent A (parallel)
    ├──► Subagent B (parallel)
    └──► Subagent C (sequential, depends on A+B)
              │
              ▼
         Synthesized answer → User
```

### How agents are defined

**Option 1 — Markdown file (no code needed):**
```yaml
---
description: "What this agent does"
tools: [Read, WebFetch]
model: opus
---
You are a specialist in...
```
Drop in `~/.claude/agents/` — auto-discovered, no registration needed.

**Option 2 — Built-in TypeScript definition:**
Create `src/tools/AgentTool/built-in/myAgent.ts`, export a `BuiltInAgentDefinition`, add to the index. Use this when the agent needs dynamic system prompt generation.

### Current built-in agents

| Agent | Type string | Purpose | Keep for Verity? |
|---|---|---|---|
| general-purpose | `general-purpose` | All-tools default workhorse | Yes |
| Explore | `Explore` | Read-only codebase/research search | Yes — adapt for literature search |
| Plan | `Plan` | Designs implementation plans | Yes — adapt for research planning |
| verification | `verification` | Runs checks, returns PASS/FAIL | Yes — adapt as clinical verifier |
| statusline-setup | `statusline-setup` | Configures status line UI | Yes, neutral utility |
| claude-code-guide | `claude-code-guide` | Explains Claude Code features | Replace with `verity-guide` |

### What's missing for healthcare

The main agent currently routes subtasks **ad-hoc** based on model judgment. For healthcare this is not good enough — high-risk tasks must always go through the right specialist and verifier, not sometimes.

The gap:
```
Current:  question → model guesses routing → maybe calls subagents
Needed:   question → classify type + risk → deterministic routing → specialist → verifier
```

---

## Verity Agent Team Design

### Team topology

```
User / Clinician
        │
        ▼
┌────────────────────────┐
│   VERITY ORCHESTRATOR  │  ← classifies task type + risk level
│   (clinical router)    │  ← routes deterministically
└──────────┬─────────────┘
           │
    ┌──────┼──────────────────────────────┐
    │      │              │               │
    ▼      ▼              ▼               ▼
┌───────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐
│  Lit  │ │  Trial   │ │  Drug    │ │    Docs      │
│Review │ │ Matcher  │ │ Checker  │ │  Assistant   │
└───────┘ └──────────┘ └──────────┘ └──────────────┘
    │           │            │              │
    └───────────┴────────────┴──────────────┘
                        │
              ┌─────────┴──────────┐
              ▼                    ▼
       ┌────────────┐      ┌──────────────┐
       │  Verifier  │      │ Audit Logger │
       │ (citations)│      │ (every call) │
       └────────────┘      └──────────────┘
```

### Agent definitions

---

#### 1. Verity Orchestrator
**File:** `src/tools/AgentTool/built-in/verityOrchestrator.ts`
**Type:** `verity-orchestrator`
**Role:** Entry point for all clinical tasks. Classifies and routes.

**Routing logic:**
| Task type | Routes to | Risk level | Verifier required? |
|---|---|---|---|
| Literature search / evidence review | lit-reviewer | Low | No |
| Drug interaction check | drug-checker | Medium | Yes |
| Clinical trial matching | trial-matcher | Medium | Yes |
| Documentation / note drafting | docs-assistant | Low | No |
| Discharge instructions | docs-assistant | Medium | Yes |
| Differential diagnosis brainstorm | lit-reviewer + verifier | High | Always |
| Anything mentioning treatment/diagnosis decision | Refuse + escalate | Very High | N/A |

**Tools:** Agent (to spawn specialists), SendMessage
**When to use:** Always — this is the top-level router for clinical tasks

---

#### 2. Literature Reviewer
**File:** `agents/lit-reviewer.md`
**Type:** `lit-reviewer`
**Role:** Evidence synthesis from PubMed and clinical guidelines.

**Behavior:**
1. Parse question into PICO format (Population, Intervention, Comparison, Outcome)
2. Search PubMed via `pubmed_search` MCP tool
3. Fetch top abstracts via `pubmed_fetch`
4. Cross-reference against NCI PDQ / USPSTF guidelines
5. Synthesize with evidence level per source (RCT / systematic review / cohort / expert opinion)
6. Return structured report with full citations (PMID + DOI)

**Tools:** PubMed MCP, Guidelines MCP, WebFetch (approved sources only)
**Output:** Markdown report with evidence level tags and citations
**Constraint:** Never state a clinical conclusion without a citation

---

#### 3. Trial Matcher
**File:** `agents/trial-matcher.md`
**Type:** `trial-matcher`
**Role:** Finds and ranks relevant open clinical trials.

**Behavior:**
1. Search `trials_search` with condition + filters
2. Run `trial_eligibility_check` against de-identified criteria
3. Cross-reference standard of care via NCI PDQ
4. Rank by eligibility fit, phase, geographic proximity
5. Return shortlist: NCT ID, phase, sponsor, eligibility summary, site contacts

**Tools:** ClinicalTrials.gov MCP, Guidelines MCP
**Output:** Ranked trial shortlist with eligibility notes
**Constraint:** Always prompt user to enter de-identified criteria only

---

#### 4. Drug Checker
**File:** `agents/drug-checker.md`
**Type:** `drug-checker`
**Role:** Drug interaction analysis and safety check.

**Behavior:**
1. Normalize drug names via `drug_rxnorm`
2. Run `drug_interactions` across the full drug list
3. Fetch full label for each drug (contraindications, warnings)
4. Check active recalls via `drug_recalls`
5. Produce severity-ranked interaction matrix

**Tools:** Drug Information MCP (OpenFDA, RxNorm, DailyMed)
**Output:** Severity table (Major / Moderate / Minor / None) + active recall alerts
**Constraint:** Always recommend pharmacist or prescriber review for Major interactions

---

#### 5. Documentation Assistant
**File:** `agents/docs-assistant.md`
**Type:** `docs-assistant`
**Role:** Drafts clinical documents, visit prep, patient education.

**Behavior:**
- Visit prep: retrieve relevant guidelines → generate checklist (before/what to bring/questions to ask)
- Discharge instructions: structured template + plain language (Grade 8 reading level)
- Note cleanup: formatting and structure only, no clinical content changes
- Coding assistance: ICD-10 / LOINC lookup via coding MCP

**Tools:** Guidelines MCP, Coding MCP (ICD-10, LOINC, SNOMED)
**Output:** Structured document with source references
**Constraint:** Flag any clinical content it did not retrieve from an approved source

---

#### 6. Verifier
**File:** `src/tools/AgentTool/built-in/verityVerifier.ts` (adapt from existing `verificationAgent.ts`)
**Type:** `verity-verifier`
**Role:** Citation and claim check before output is returned to user.

**Behavior:**
1. Receive draft output + source list from calling agent
2. For each clinically material claim: check citation exists and matches claim
3. Flag unsupported claims
4. Flag stale evidence (configurable threshold, default 5 years)
5. Return: PASS / PARTIAL (with flagged items) / FAIL (block output)

**Tools:** Read (draft), PubMed MCP (verify citations)
**Output:** Verification report; FAIL blocks output, PARTIAL adds warning banner
**When to invoke:** Always after drug-checker and trial-matcher; always for high-risk outputs

---

#### 7. Verity Guide (replaces claude-code-guide)
**File:** `src/tools/AgentTool/built-in/verityGuideAgent.ts`
**Type:** `verity-guide`
**Role:** Answers questions about Verity Health Agent features, commands, and configuration.

**Replaces:** `claude-code-guide` (which answers Claude Code / Anthropic API questions — irrelevant to clinicians)

---

### Audit Logger (not an agent — a hook)

Implemented as a `PostToolUse` hook in Phase 1, not a subagent. Fires after every tool call automatically. See `HEALTHAGENT_DEV_PLAN.md` Phase 1.2.

---

## Implementation Order

### Phase 2 prerequisite (must exist before agents can work)
The specialist agents are only useful once their MCP tools exist. Build MCP servers first:
- PubMed MCP → powers lit-reviewer
- ClinicalTrials.gov MCP → powers trial-matcher
- Drug Information MCP → powers drug-checker
- Coding MCP → powers docs-assistant
- Guidelines MCP → powers all agents

See `HEALTHAGENT_DEV_PLAN.md` Phase 2 for full MCP server specs.

### Phase 3: Add agents in this order
1. `lit-reviewer.md` — simplest, only needs PubMed + Guidelines MCP
2. `drug-checker.md` — well-defined tool chain
3. `trial-matcher.md` — depends on trials MCP + guidelines
4. `docs-assistant.md` — depends on coding + guidelines MCP
5. `verity-verifier.ts` — adapt existing verificationAgent.ts
6. `verity-guide.ts` — replace claudeCodeGuideAgent.ts
7. `verity-orchestrator.ts` — build last, after all specialists are tested individually

### Phase 4: Wire the orchestrator
Connect orchestrator routing to the full team. Test end-to-end with the cancer patient coordination scenario from `HEALTHAGENT_DEV_PLAN.md` Phase 4.

---

## Comparison: Verity vs Microsoft Healthcare Agents Orchestrator

| Dimension | Verity (this repo) | Microsoft HCO |
|---|---|---|
| Orchestration | Explicit orchestrator agent with routing table | Explicit orchestrator, pre-registered specialist agents |
| Agent definitions | Markdown frontmatter or TypeScript | Python classes with typed interfaces |
| Communication | SendMessage tool + mailbox + AppState | Shared memory store + structured handoffs |
| Clinical specialization | Phase 3 adds domain agents | Pre-built (triage, imaging, labs, EHR) |
| Workflow routing | Orchestrator with risk-tiered routing table | Risk-tiered routing |
| Parallelism | In-process async or tmux panes | Async task graph |
| Audit | Phase 1 hook (append-only JSONL) | Built-in compliance logging |
| Adding a new agent | Drop a markdown file | Register Python class |

**Key difference:** Microsoft ships pre-built clinical agents. Verity builds its own, which means more work upfront but full control over what each agent does, what data it touches, and where it calls out — which matters for compliance.

---

## Files To Create (Summary)

```
agents/                          ← markdown agent definitions (Phase 3)
├── lit-reviewer.md
├── trial-matcher.md
├── drug-checker.md
└── docs-assistant.md

src/tools/AgentTool/built-in/    ← TypeScript built-ins (Phase 3)
├── verityOrchestrator.ts        ← new
├── verityVerifier.ts            ← adapt from verificationAgent.ts
└── verityGuideAgent.ts          ← replace claudeCodeGuideAgent.ts
```
