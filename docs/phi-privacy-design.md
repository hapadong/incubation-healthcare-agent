# PHI Privacy-Preserving Design

Verity Health Agent implements a two-layer PHI defense that prevents patient data from crossing outside the authorized perimeter. This document describes the implementation — what runs, where, and why each design choice was made.

For deployment policy and rules, see `config/phi-rules-base.md`.

---

## Core Model: The Authorized Perimeter

PHI is not blocked universally — it is confined to a perimeter. Within the perimeter (on-prem inference, EHR MCP tools, audit logs on hospital infrastructure), PHI flows freely. Outside the perimeter (public web search, external APIs, any unBAA'd cloud service), PHI must never appear.

```
┌─────────────────────────────── Authorized Perimeter ───────────────────────────────┐
│                                                                                     │
│   Clinician workstation  →  Verity Agent  →  Azure OpenAI (BAA-covered)            │
│                                    ↓                                                │
│                          EHR / MIMIC MCP tools   Audit log (~/.healthagent/)       │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
          PHI may NOT cross this boundary →  WebSearch / WebFetch / Public MCP APIs
```

The agent enforces the boundary. Clinical judgment about what constitutes PHI stays with the clinician.

---

## Layer 1 — Behavioral: System Prompt De-identification

**File**: `src/constants/prompts.ts`  
**Trigger**: Active whenever `HEALTHAGENT_API_BASE_URL` is set

The system prompt instructs the model to de-identify any query before calling an external tool:

> Strip direct patient identifiers (name, DOB, MRN, phone, email, address, SSN). Preserve all clinical facts: age range, sex, diagnosis, stage, biomarkers, mutations, treatments, comorbidities, lab values, medications.

**Why this layer exists**: High-precision regex cannot catch fuzzy identifiers like names, relative dates ("seen last Tuesday"), or narrative descriptions that imply identity. The model handles the ambiguous cases that structural patterns cannot.

**Limitation**: This layer relies on model behavior. It does not block — it guides. The structural layer below provides the hard stop.

---

## Layer 2 — Structural: PreToolUse Hook

**Files**: `src/utils/healthagent/phiScanner.ts`, `src/utils/healthagent/complianceHooks.ts`  
**Trigger**: Registered at session start via `src/setup.ts` (line 377); fires on every tool call

### PHI Pattern Detection

Three high-confidence regex patterns chosen for minimal false positives in clinical text:

| Category | Pattern | Matches |
|----------|---------|---------|
| SSN | `\b\d{3}[-\s]\d{2}[-\s]\d{4}\b` | `123-45-6789`, `123 45 6789` |
| Email | `\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b` | Standard email addresses |
| Phone | `\b(\+1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b` | US formats including `+1` prefix |

**Why names, dates, and ZIP codes are excluded**: These appear constantly in clinical text (drug names contain person names; dates are central to clinical documentation; ZIP codes appear in addresses and study sites). Including them would produce unacceptable false-positive rates that block legitimate clinical queries.

### Tool Boundary Classification

The hook only fires on external tools. Classification logic in `phiScanner.ts`:

```
Always internal (never scanned):   Read, Write, Edit, Glob, Grep, Bash, Agent, TodoWrite, ...
Always external (always scanned):  WebSearch, WebFetch
MCP tools (name contains "__"):    External by default
    Exception: listed in HEALTHAGENT_INTERNAL_TOOLS → treated as internal
```

**Why MCP tools default to external**: MCP servers may connect to anything. The safe default is to treat them as outside the perimeter and require explicit opt-in for hospital-internal servers (e.g., `mimic__query`, `patients__lookup`).

### Blocking Behavior

When a pattern matches:

1. Hook returns `{ decision: 'block', reason: "PHI detected in external call (SSN). Re-phrase using clinical descriptors only." }`
2. Tool call is refused — input is never sent to the external service
3. The detected categories (e.g., "SSN", "phone") are shown to the user; the matched content is not
4. An audit entry is written (see below)
5. The model must retry with de-identified input

The hook never modifies input. It either allows or blocks, so the external service sees either a clean query or nothing.

---

## Audit Trail

**File**: `src/utils/healthagent/auditLogger.ts`  
**Hook type**: PostToolUse (fires after every tool call, internal and external)

### Storage

```
~/.healthagent/audit/YYYY-MM-DD.jsonl   ← one file per day, append-only
```

Permissions: `0700` (owner read/write only). Daily bucketing supports log rotation and archival.

### Entry Structure

```jsonc
{
  "timestamp": "2026-05-18T14:32:01.442Z",
  "session_id": "sess_abc123",
  "user": "dwang7",
  "tool": "WebSearch",
  "external": true,
  "input_hash": "e3b0c44298fc1c149afb...",   // SHA256 of JSON.stringify(input)
  "phi_blocked": false,
  "outcome": "success"
}
```

When PHI is blocked, `phi_blocked: true` and `phi_categories: ["SSN"]` are added.

### Privacy-Preserving Choices

| Choice | Reason |
|--------|--------|
| SHA256 hash instead of raw input | Audit log is readable by compliance teams — raw PHI must not appear there |
| Categories logged, not matched content | `["SSN"]` is sufficient for compliance review; the actual number is not needed |
| Append-only JSONL | Immutable record; no update/delete path that could be used to cover access |
| No patient name or DOB in log | Patient reference (encounter ID) is sufficient for EHR linking |

---

## Unicode Sanitization

**File**: `src/utils/sanitization.ts`  
**Applied to**: All external API responses and MCP tool outputs before they enter the model context

Protects against hidden character attacks that could smuggle adversarial instructions through tool results:

- NFKC normalization
- Strips Unicode format characters (`\p{Cf}`), private-use characters (`\p{Co}`), and unassigned codepoints (`\p{Cn}`)
- Explicit removal of zero-width spaces, directional marks, BOM, and private-use plane characters
- Based on the ASCII Smuggling / hidden prompt injection class of attacks (HackerOne #3086545)

This layer is not PHI-specific — it protects the model's reasoning from being hijacked by data returned from external sources.

---

## Activation and Configuration

Everything activates when `HEALTHAGENT_API_BASE_URL` is set:

| What activates | Where |
|----------------|-------|
| System prompt de-identification instruction | `src/constants/prompts.ts` |
| PreToolUse PHI scan hook | `src/setup.ts` → `complianceHooks.ts` |
| PostToolUse audit log hook | `src/setup.ts` → `auditLogger.ts` |
| Audit directory `~/.healthagent/audit/` | `auditLogger.ts` on first write |

**Whitelisting internal MCP tools** (skip PHI scan for hospital-internal servers):
```bash
HEALTHAGENT_INTERNAL_TOOLS=mimic__query,mimic__labs,patients__patient_list,patients__patient_load
```

**Override audit/session directory** (for multi-user or managed deployments):
```bash
HEALTHAGENT_HOME=/var/healthagent
```

---

## Files Reference

| File | Role |
|------|------|
| `src/utils/healthagent/phiScanner.ts` | Regex patterns; tool classification (internal vs. external) |
| `src/utils/healthagent/complianceHooks.ts` | PreToolUse hook registration and blocking logic |
| `src/utils/healthagent/auditLogger.ts` | PostToolUse hook; append-only JSONL audit trail |
| `src/constants/prompts.ts` | System prompt de-identification instruction |
| `src/setup.ts` | Hook registration at session start |
| `src/services/tools/toolHooks.ts` | Hook invocation and blocking decision in tool pipeline |
| `src/utils/sanitization.ts` | Unicode sanitization of external responses |
| `config/phi-rules-base.md` | Deployment policy and rules reference |
