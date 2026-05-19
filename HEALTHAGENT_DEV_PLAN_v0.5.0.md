# HealthAgent v0.5.0 — Development Plan

**Base:** HealthAgent v0.4.0
**Goal:** Adaptive context management — model-aware compaction thresholds, flexible token
budgeting for local and cloud models, SSO/SAML, FHIR output
**Status:** Planning

---

## Problem Statement

HealthAgent v0.1.0–v0.4.0 inherits context-management constants that were designed exclusively
for Claude's 200k context window. When running against local models (oMLX, Ollama, vLLM) with
smaller context windows, the math breaks catastrophically. The same constants also need
verification for cloud models (GPT-4o, Gemini) that have different window sizes than Claude.

---

## Part A — Context / Compaction Math: Root Cause Analysis

### The constants (all hardcoded in Anthropic source, not HealthAgent additions)

| Constant | Value | File | Purpose |
|---|---|---|---|
| `MAX_OUTPUT_TOKENS_FOR_SUMMARY` | 20,000 | `src/services/compact/autoCompact.ts:30` | Tokens reserved for compaction summary output |
| `AUTOCOMPACT_BUFFER_TOKENS` | 13,000 | `src/services/compact/autoCompact.ts:62` | Safety headroom before compaction fires |
| `WARNING_THRESHOLD_BUFFER_TOKENS` | 20,000 | `src/services/compact/autoCompact.ts:63` | Tokens below threshold that trigger the warning banner |
| `MAX_OUTPUT_TOKENS_DEFAULT` | 32,000 | `src/utils/context.ts:15` | Default max output for unknown models |
| `MAX_OUTPUT_TOKENS_UPPER_LIMIT` | 64,000 | `src/utils/context.ts:16` | Default upper limit for unknown models |

These constants are calibrated for Claude on 200k context. `20,000` for summary output is
correct — Anthropic measured their p99.99 compact summary at 17,387 tokens. `13,000` as
a safety buffer is ~7% of 200k, a reasonable margin. On 200k everything works:

```
effectiveContextWindow = 200,000 − min(32,000, 20,000) = 180,000
autoCompactThreshold   = 180,000 − 13,000              = 167,000  (fires at 83% usage)
warningThreshold       = 167,000 − 20,000              = 147,000  (warns at 73% usage)
```

### The breakdown on a 32k local model

With `HEALTHAGENT_MAX_CONTEXT_TOKENS=32768` and no output token override, `getMaxOutputTokensForModel`
returns `32,000` (the `MAX_OUTPUT_TOKENS_DEFAULT` for any unrecognised model name):

```
effectiveContextWindow = 32,768 − min(32,000, 20,000) = 12,768
autoCompactThreshold   = 12,768 − 13,000              = −232   ← NEGATIVE
```

**A negative threshold means `tokenUsage >= threshold` is always true.** Compaction fires on
every single message, including the very first one before any conversation history exists.

### Why the status bar always shows "100% until auto-compact"

oMLX (and most local model servers) do not return per-request token usage in their API
responses. `tokenUsage` in the UI is therefore always `0`.

With `threshold = −232` and `tokenUsage = 0`:

```
percentLeft = (threshold − tokenUsage) / threshold × 100
            = (−232 − 0) / −232 × 100
            = 100%
```

The display always reads `100% until auto-compact` — misleadingly suggesting full capacity —
while compaction fires on every exchange because `0 >= −232`.

### The temporary workaround shipped in v0.4.x

Added `HEALTHAGENT_MAX_OUTPUT_TOKENS` env var support in `src/services/api/claude.ts`.
When set, it overrides the `32,000` default output reservation for unknown models.

With `HEALTHAGENT_MAX_OUTPUT_TOKENS=4096`:

```
effectiveContextWindow = 32,768 − min(4,096, 20,000) = 28,672
autoCompactThreshold   = 28,672 − 13,000              = 15,672  ← positive, sane
```

Compaction no longer fires on every message. However, the system prompt on a fully-loaded
ha instance (all MCP tools + Claude's base instructions) consumes approximately 13,000 tokens,
leaving only ~2,672 tokens of headroom per exchange before the next compaction. This is
functional but still limits comfortable use to short exchanges.

The `warningThreshold = 15,672 − 20,000 = −4,328` remains negative, so the warning banner
still shows permanently. This is cosmetic — compaction behaviour is correct.

### Behaviour on cloud models (GPT-4o, Gemini)

Cloud models with large context windows are unaffected by this issue:

| Model | Context window | effectiveContextWindow | autoCompactThreshold | Status |
|---|---|---|---|---|
| Claude Sonnet 4.6 | 200,000 | 180,000 | 167,000 | ✅ Works correctly |
| GPT-4o / GPT-4o-mini | 128,000 | 108,000 | 95,000 | ✅ Works correctly |
| Gemini 1.5 Pro / 2.0 Flash | 1,000,000 | 980,000 | 967,000 | ✅ Works correctly |
| Azure OpenAI GPT-4o | 128,000 | 108,000 | 95,000 | ✅ Works correctly |
| **oMLX Gemma 4 26B (32k)** | **32,768** | **12,768** | **−232** | **❌ Breaks** |
| **Ollama Llama 3.1 (32k)** | **32,768** | **12,768** | **−232** | **❌ Breaks** |
| Local model with 64k+ context | 65,536+ | 45,536+ | 32,536+ | ✅ Works correctly |

The hardcoded constants are adequate for any model with ≥ 64k context. They only break for
local models configured with ≤ 32k context windows.

### The proper fix (deferred to v0.5.0)

Replace the hardcoded constants with model-aware adaptive values. The core insight:
`MAX_OUTPUT_TOKENS_FOR_SUMMARY` and `AUTOCOMPACT_BUFFER_TOKENS` should scale with the context
window, not be absolute values.

**Proposed formula:**

```typescript
// src/services/compact/autoCompact.ts

function getAdaptiveCompactionBudget(contextWindow: number): {
  summaryReserve: number  // tokens reserved for compaction output
  buffer: number          // safety buffer before threshold fires
  warningBuffer: number   // additional buffer for warning banner
} {
  if (contextWindow >= 100_000) {
    // Original Anthropic values — calibrated for Claude
    return { summaryReserve: 20_000, buffer: 13_000, warningBuffer: 20_000 }
  }
  if (contextWindow >= 64_000) {
    return { summaryReserve: 8_000, buffer: 6_000, warningBuffer: 10_000 }
  }
  if (contextWindow >= 32_000) {
    return { summaryReserve: 4_000, buffer: 4_000, warningBuffer: 6_000 }
  }
  // Very small windows (< 32k): minimal reserves
  return { summaryReserve: 2_000, buffer: 2_000, warningBuffer: 4_000 }
}
```

With 32k context and adaptive values:
```
summaryReserve         = 4,000
buffer                 = 4,000
effectiveContextWindow = 32,768 − 4,000 = 28,768
autoCompactThreshold   = 28,768 − 4,000 = 24,768  ← fires at 75% usage
warningThreshold       = 24,768 − 6,000 = 18,768  ← warns at 57% usage
```

This gives ~11k of conversation headroom above a 13k system prompt before compaction fires —
roughly 8–12 normal exchanges rather than 2–3.

**Additionally:** use `HEALTHAGENT_MAX_OUTPUT_TOKENS` (already shipped) to determine
`summaryReserve` when set, instead of the hardcoded tier values. This lets operators tune
precisely for their model.

### oMLX Memory Settings Explained

oMLX exposes three distinct settings that are frequently confused:

| Setting | What it controls |
|---|---|
| **Max Model Memory** | Hard cap on RAM oMLX will use to load model weights. If the model file exceeds this, oMLX returns 507 and refuses to load. |
| **Max Context Window** | How many tokens the KV cache is pre-allocated for. Larger = more RAM consumed at runtime, but allows longer conversations without truncation. |
| **Max Tokens** | Maximum tokens the model will generate per response. Affects output length only, not memory. |

**Why 507 "exceeds max-model-memory" happens:** The model weight file (e.g. Gemma 4 26B at 15.26 GB)
is larger than the configured Max Model Memory cap. This is an oMLX UI setting — raise it above the
model size to allow loading.

**Memory budget formula for Macs:**

```
total_ram_needed = model_weights + kv_cache + os_overhead
kv_cache ≈ context_window_tokens × num_layers × head_dim × 2 × 2 bytes  (bfloat16)
```

For Gemma 4 26B (4-bit quantized, ~15.3 GB weights), approximate KV cache sizes:

| Context window | KV cache (est.) | Total model RAM |
|---|---|---|
| 32k | ~1.0 GB | ~16.3 GB |
| 64k | ~2.0 GB | ~17.3 GB |
| 128k | ~4.0 GB | ~19.3 GB |
| 200k | ~6.3 GB | ~21.6 GB |

### Recommended oMLX Settings by Mac RAM

| Mac RAM | Max Model Memory | Max Context Window | `HEALTHAGENT_MAX_CONTEXT_TOKENS` | Notes |
|---|---|---|---|---|
| 16 GB | 13 GB | 32k | 32768 | Tight; close all other apps. Set `HEALTHAGENT_MAX_OUTPUT_TOKENS=4096`. |
| 24 GB | 18 GB | 64k | 65536 | Comfortable for most clinical sessions. |
| 32 GB | 20 GB | 128k | 131072 | Full 128k context; no adaptive fix needed. |
| 48 GB | 20 GB | 200k | 200000 | Full 200k; matches Claude's default behaviour. |
| 64 GB+ | 20 GB | 200k | 200000 | Same as 48 GB — model weights don't change. |

`Max Model Memory` only needs to exceed the model weight size (~15.3 GB for Gemma 4 26B 4-bit).
Setting it higher than ~20 GB provides no benefit — the weights don't grow.

### Recommendation for local model users today (v0.4.x)

**Step 1 — Fix oMLX settings (UI):**
- Set **Max Model Memory** to at least 18 GB (must exceed model weight size of 15.26 GB)
- Set **Max Context Window** based on your Mac RAM (see table above)
- **Max Tokens** can stay at its default (e.g. 4096) — this is just the per-response output cap

**Step 2 — Set `~/.healthagent/.env` to match:**

For 16 GB Mac (32k context):
```bash
HEALTHAGENT_MAX_CONTEXT_TOKENS=32768
HEALTHAGENT_MAX_OUTPUT_TOKENS=4096      # prevents the compaction loop on 32k window
```

For 32 GB+ Mac (128k context):
```bash
HEALTHAGENT_MAX_CONTEXT_TOKENS=131072
HEALTHAGENT_MAX_OUTPUT_TOKENS=8192
```

For 48 GB+ Mac (200k context):
```bash
HEALTHAGENT_MAX_CONTEXT_TOKENS=200000
HEALTHAGENT_MAX_OUTPUT_TOKENS=8192
```

With 128k+ context the original Anthropic constants work fine and no adaptive fix is needed.

---

## Part B — v0.5.0 Feature Work

The following features were deferred from v0.4.0 or are new for v0.5.0.

### B.1 — Adaptive Context Management (from Part A)

- [ ] **10.1** Replace hardcoded `MAX_OUTPUT_TOKENS_FOR_SUMMARY`, `AUTOCOMPACT_BUFFER_TOKENS`,
  `WARNING_THRESHOLD_BUFFER_TOKENS` in `autoCompact.ts` with `getAdaptiveCompactionBudget(contextWindow)`
- [ ] **10.2** When `HEALTHAGENT_MAX_OUTPUT_TOKENS` is set, use it as `summaryReserve` directly
  (already available via the v0.4.x env var; wire it into `getAdaptiveCompactionBudget`)
- [ ] **10.3** Add `HEALTHAGENT_COMPACTION_BUFFER` env var for operators who want manual control
  over the safety buffer (alternative to the tier lookup)
- [ ] **10.4** Test: run ha against a 32k oMLX model; verify no compaction on first message;
  verify compaction fires only after significant conversation history
- [ ] **10.5** Test: run ha against Claude 200k; verify original behaviour unchanged

### B.2 — SSO / SAML (hospital IdP integration)

Deferred from v0.4.0. Hospital IT environments require integration with existing identity
providers (Azure AD, Okta, Epic SSO) rather than local email/password accounts.

- [ ] **10.6** Integrate `passport-saml` or `openid-client` for OIDC/SAML flows
- [ ] **10.7** Map IdP groups/roles to HealthAgent `role` field (user / admin / read-only)
- [ ] **10.8** Support `HEALTHAGENT_OIDC_ISSUER`, `HEALTHAGENT_OIDC_CLIENT_ID/SECRET` env vars
- [ ] **10.9** Keep local email/password auth as fallback when SSO env vars not set

### B.3 — FHIR Output & EHR Write-back

Deferred from v0.4.0.

- [ ] **10.10** Structured FHIR R4 output for clinical summaries (Patient, Condition, MedicationStatement)
- [ ] **10.11** Export to EHR via FHIR REST endpoint (SMART on FHIR client)
- [ ] **10.12** PDF export of clinical session notes

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
| 9 — Multi-User | Auth, storage abstraction, MCP HTTP, horizontal scaling | 🔲 Planning |
| **10 — Adaptive Context** | **Model-aware compaction, SSO, FHIR output** | **🔲 Planning** |

### Phase 10 Sub-tasks

| Sub-phase | Work | Status |
|-----------|------|--------|
| 10.1–10.5 | Adaptive compaction budget (local model fix) | 🔲 Todo |
| 10.6–10.9 | SSO / SAML / OIDC | 🔲 Todo |
| 10.10–10.12 | FHIR output, EHR write-back, PDF export | 🔲 Todo |
