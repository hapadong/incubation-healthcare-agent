# Healthcare Agent Adaptation Plan

## Objective

This document describes how to adapt the Claude Code CLI architecture in this repository into a healthcare-focused agent system optimized for:

1. accuracy first,
2. source-backed actions,
3. reduced hallucination,
4. clinically useful and professional output,
5. support for multiple model providers,
6. strong safety, auditability, and extensibility.

This is not a recommendation to deploy an autonomous medical system. The correct target architecture is a clinician-facing copilot with enforced evidence retrieval, verification, and human review for medium- and high-risk workflows.

## Executive Position

This repo is a good foundation for a healthcare agent because it already has the right structural ingredients:

- a model-driven agent loop,
- explicit tool interfaces,
- permissions and policy layers,
- extension surfaces,
- streaming and headless modes,
- task and sub-agent infrastructure,
- structured output support,
- remote and SDK-ready execution paths.

It is not healthcare-ready as-is.

The main changes required are:

- replace general-purpose tooling with domain-restricted tooling,
- add evidence retrieval and citation enforcement,
- add medical verification layers,
- introduce risk-tiered workflow routing,
- add audit and compliance controls,
- harden provider and deployment policy choices.

## Recommended Product Shape

Do not build “AI doctor.”

Build a clinical copilot with bounded workflows.

Recommended early scopes:

- guideline lookup and evidence synthesis
- chart summarization
- discharge instruction drafting
- prior-auth and utilization-review drafting
- medication education
- coding / documentation assistance
- differential-diagnosis brainstorming for clinician review

Avoid in v1:

- autonomous diagnosis
- final treatment selection
- emergency triage without clinician review
- imaging or waveform interpretation unless separately validated and regulated

## Mapping This Repo To A Healthcare Variant

### What Can Be Reused

#### Query Runtime

Use:

- `src/QueryEngine.ts`
- `src/query.ts`

Why:

- they already support multi-turn tool-using agent flows
- they can stream output and support structured responses
- they already integrate with permission and tool execution layers

Healthcare adaptation:

- constrain the model loop to healthcare-allowed tool pools
- inject healthcare-specific system prompts and output schemas
- require evidence before action for clinical workflows

#### Tool Framework

Use:

- `src/Tool.ts`
- `src/tools.ts`
- `src/services/tools/*`

Why:

- this is the best reusable core in the repo
- tool execution is already permission-aware and hook-aware
- concurrency and streaming are already engineered

Healthcare adaptation:

- replace generic tool exposure with domain tools
- remove or heavily gate dangerous shell/edit capabilities in production clinical workflows

#### Permission Model

Use:

- `src/utils/permissions/*`
- tool filtering model

Why:

- healthcare needs strict runtime policy control
- this repo already assumes the model should not see unrestricted actions

Healthcare adaptation:

- reinterpret permission rules as clinical workflow and data-access policies
- add risk-tiered decision gates

#### Skills / Plugins / MCP

Use:

- skills for workflow packaging
- plugins for controlled extensions
- MCP for external clinical systems, knowledge providers, and institutional tools

Healthcare adaptation:

- create provider-approved clinical connectors
- expose only evidence and workflow tools, not general tool discovery

## Proposed Healthcare Architecture

```text
User / Clinician
  -> UI or SDK request
  -> workflow router
  -> healthcare-scoped QueryEngine session
  -> approved tool pool only
  -> evidence retrieval
  -> draft generation
  -> claim verifier
  -> policy/rules engine
  -> confidence + escalation gate
  -> audited final output
```

## New Core Subsystems To Add

### 1. Clinical Workflow Router

Purpose:

- classify incoming tasks into low, medium, high risk
- choose the right workflow and tool pool
- determine whether clinician review is mandatory

Suggested risk classes:

- Low risk: patient education, note cleanup, coding assistance
- Medium risk: evidence summary, differential generation, discharge instructions
- High risk: medication recommendations, triage suggestions, diagnostic reasoning
- Very high risk: autonomous diagnosis/treatment decisions, image/signal interpretation

Implementation idea:

- new `services/clinical/routing.ts`
- outputs:
  - workflow type
  - risk level
  - required tool set
  - output schema
  - review requirement

### 2. Evidence Retrieval Layer

Purpose:

- retrieve current, approved clinical evidence before the model answers

Approved source classes:

- CDC
- FDA
- NIH / NLM
- WHO
- NICE
- USPSTF
- specialty society guidelines
- approved internal clinical protocols
- peer-reviewed evidence repositories

Implementation options:

- MCP-backed evidence connectors
- internal retrieval API with normalized document schema
- hybrid vector + metadata retrieval

Document metadata should include:

- source authority
- title
- publication / guideline version
- date
- jurisdiction
- specialty
- patient population applicability
- evidence level

Suggested new tools:

- `ClinicalSearchTool`
- `GuidelineFetchTool`
- `DrugReferenceTool`
- `ProtocolLookupTool`

### 3. Citation And Claim Verifier

Purpose:

- ensure every clinically material claim has evidence
- block unsupported recommendations

Required behavior:

- map claims to citations
- detect unsupported or weakly supported claims
- force uncertainty language or refusal
- detect stale evidence if freshness thresholds are exceeded

Implementation pattern:

- generator model drafts
- verifier model or deterministic verifier checks citations
- rules engine enforces “no citation, no answer” for specified workflows

Suggested modules:

- `services/clinical/claimExtraction.ts`
- `services/clinical/verification.ts`
- `services/clinical/citationPolicy.ts`

### 4. Clinical Rules Engine

Purpose:

- deterministic checks on high-risk outputs

Examples:

- age appropriateness
- pregnancy/lactation flags
- renal/hepatic adjustment reminders
- allergy and interaction checks
- contraindication checks
- red-flag symptoms requiring escalation
- inpatient vs outpatient path constraints

Implementation idea:

- run after generation and before final output
- can be partly rule-based and partly API-backed

Suggested module:

- `services/clinical/rulesEngine.ts`

### 5. Structured Output Contracts

Purpose:

- standardize professional outputs
- reduce rambling and hallucination

Suggested schemas by workflow:

- evidence summary
- patient-facing education
- clinician-facing recommendation memo
- discharge instructions
- medication counseling
- differential diagnosis draft

Common schema fields:

- summary
- evidence-backed findings
- contraindications / red flags
- recommended next steps
- citations
- uncertainty/confidence
- escalation note

This repo already has structured-output support patterns via synthetic output tooling; that should be reused.

### 6. Audit And Trace Layer

Purpose:

- make every answer reviewable

Every output should retain:

- user input
- workflow type
- risk class
- retrieved sources
- citations used
- model/provider/version
- verifier results
- rules-engine results
- final confidence
- human review decision if applicable

Suggested module:

- `services/clinical/auditLog.ts`

## Tooling Changes

## Remove Or Heavily Gate

For a healthcare production system, the following general tools should not be broadly exposed:

- unrestricted shell execution
- arbitrary filesystem editing
- broad web search
- arbitrary web fetch over the public internet
- unconstrained plugin/tool discovery

These are useful in a developer CLI, but not appropriate as a default action surface in a clinical copilot.

## Add Domain-Specific Tools

Suggested initial healthcare tool pool:

- `PatientContextTool`
  - reads structured patient context from approved input schema
- `ClinicalSearchTool`
  - searches only approved sources
- `GuidelineFetchTool`
  - resolves guideline sections with metadata
- `DrugReferenceTool`
  - dosing, interactions, contraindications
- `LabInterpretationReferenceTool`
  - reference ranges and interpretation guidance, not autonomous diagnosis
- `ProtocolLookupTool`
  - organization-specific protocols
- `CitationAssemblerTool`
  - turns evidence fragments into structured citations
- `EscalationPolicyTool`
  - returns whether the workflow requires human review

## Suggested Tool Exposure Modes

### Mode A: Documentation Assistant

Allowed:

- patient context
- coding references
- note templates
- policy/protocol lookup

### Mode B: Evidence Synthesis

Allowed:

- clinical search
- guideline fetch
- citation assembly
- structured output

### Mode C: Clinical Recommendation Drafting

Allowed:

- all evidence tools
- rules engine
- verifier
- escalation tool

Disallowed:

- final autonomous discharge or prescribing without review flag

## Prompting Strategy

Fine-tuning alone is not the answer. Prompting plus runtime control matters more.

### System Prompt Requirements

The healthcare system prompt should enforce:

- evidence-first reasoning
- no uncited clinical claims
- explicit uncertainty
- professional, concise tone
- distinction between evidence summary and clinical recommendation
- mandatory escalation when information is insufficient or risk is high

### Answer Structure

Use standard clinician-facing sections:

- Clinical summary
- Evidence-backed assessment
- Differential or considerations
- Red flags / contraindications
- Suggested next steps
- Citations
- Confidence / uncertainty
- Human review requirement

### Hallucination Control

Prompt-level controls:

- do not answer from memory when evidence retrieval fails
- prefer “insufficient evidence” over invention
- do not fabricate guideline sections or trial data
- never invent patient-specific facts

## Model Strategy

## Principle

Use provider abstraction. Do not tie the whole system to one vendor or one consumer subscription path.

### Recommended Provider Categories

#### Commercial API Models

Use for:

- production generation
- verifier models
- structured outputs

Good fit:

- Anthropic API
- OpenAI API
- other commercial enterprise APIs if contractually/compliantly suitable

#### Self-Hosted Models

Use for:

- internal summarization
- lower-risk drafting
- privacy-sensitive workloads when your infra can support it
- secondary verification / ensemble checks

Tradeoff:

- more operational control
- more evaluation burden
- potentially weaker quality than frontier hosted models depending on model choice

#### Consumer Subscriptions

Use only for:

- manual interactive experimentation
- individual evaluation, not production automation

Do not use as production backend.

Reason:

- product/terms risk
- compliance ambiguity
- reliability and access-control issues
- potential account enforcement/bans if automated or repurposed beyond intended use

## Ban / Enforcement Risk

Practical guidance:

- API or enterprise/commercial products are the safe route
- consumer ChatGPT/Claude subscriptions are not an acceptable production architecture
- do not automate consumer web apps or unofficial endpoints for a clinical system

Operationally, that creates risk of:

- account suspension
- access instability
- policy violations
- inability to get required contractual assurances

## Fine-Tuning Strategy

Fine-tuning should come after retrieval and safety infrastructure.

### Good Use Cases For Fine-Tuning

- output style consistency
- institution-specific templates
- better schema adherence
- specialty-specific language and document structure

### Bad Use Cases For Fine-Tuning

- keeping medical knowledge current
- enforcing citation fidelity
- replacing verification
- making an unsafe workflow safe

## Suggested Codebase Adaptation

## New Major Directories

```text
src/services/clinical/
src/tools/clinical/
src/workflows/clinical/
src/schemas/clinical/
src/policies/clinical/
```

## Suggested Module Map

### `src/services/clinical/`

- `routing.ts`
- `evidenceRetrieval.ts`
- `verification.ts`
- `citationPolicy.ts`
- `rulesEngine.ts`
- `riskScoring.ts`
- `auditLog.ts`
- `clinicalPromptBuilder.ts`

### `src/tools/clinical/`

- `ClinicalSearchTool.ts`
- `GuidelineFetchTool.ts`
- `DrugReferenceTool.ts`
- `ProtocolLookupTool.ts`
- `CitationAssemblerTool.ts`
- `EscalationPolicyTool.ts`

### `src/workflows/clinical/`

- `patientEducation.ts`
- `evidenceSummary.ts`
- `differentialDraft.ts`
- `dischargeInstructions.ts`
- `documentationAssist.ts`

### `src/schemas/clinical/`

- `evidenceSummarySchema.ts`
- `recommendationSchema.ts`
- `patientEducationSchema.ts`
- `medicationCounselingSchema.ts`

### `src/policies/clinical/`

- `sourceAllowlist.ts`
- `riskThresholds.ts`
- `humanReviewPolicy.ts`
- `refusalPolicy.ts`

## How Existing Repo Pieces Would Change

### `src/tools.ts`

Change:

- create a healthcare tool preset or a dedicated healthcare runtime build
- expose only clinical tools for production clinical workflows

### `src/commands.ts`

Change:

- add commands/workflows like:
  - `/clinical-summary`
  - `/evidence-review`
  - `/patient-education`
  - `/medication-counseling`
  - `/discharge-draft`

### `src/query.ts`

Change:

- enforce pre-answer evidence retrieval for clinical workflows
- inject verifier and rules-engine post-processing
- block completion if required citations are missing

### `src/QueryEngine.ts`

Change:

- add workflow metadata and risk metadata to the per-session config
- carry audit payloads through the lifecycle

### `src/services/mcp/*`

Change:

- integrate trusted clinical MCP providers only
- disallow arbitrary MCP servers in production healthcare mode

### `src/utils/permissions/*`

Change:

- add clinical policy gates alongside execution safety gates
- distinguish data-access permissions from action permissions

## Suggested Safety Policy

### Always Allowed

- summarize retrieved evidence
- generate patient-friendly restatements of approved content
- produce citation-rich internal memos

### Allowed With Review

- differential drafts
- medication counseling drafts
- discharge instructions
- utilization review or appeal drafts

### Always Escalate Or Refuse

- final diagnosis
- emergency triage without clinician review
- definitive treatment instructions without cited evidence and reviewer signoff
- outputs based on missing or stale evidence

## Evaluation Strategy

This is mandatory.

### Build A Medical Eval Set

Include:

- common ambulatory cases
- inpatient scenarios
- medication scenarios
- contraindication cases
- adversarial source-conflict cases
- missing-information cases
- stale-guideline cases

Metrics:

- citation accuracy
- unsupported claim rate
- hallucination rate
- red-flag detection
- refusal correctness
- workflow routing accuracy
- human-review trigger precision

### Evaluate By Risk Tier

Do not average everything together. Low-risk and high-risk workflows should have different pass criteria.

## Deployment Modes

### 1. Internal Clinical Drafting Tool

Best first deployment.

Characteristics:

- clinician-facing
- institution-controlled users
- strong audit logs
- human review built in

### 2. Patient-Facing Education Assistant

Possible second deployment.

Characteristics:

- lower-risk scope only
- strict use of approved content
- strong refusal and escalation behavior

### 3. Autonomous Clinical Agent

Not recommended from this base architecture without far more validation and likely regulatory work.

## Recommended Implementation Sequence

1. Build source allowlist and clinical retrieval layer
2. Build fixed structured outputs for 2-3 low-risk workflows
3. Build citation verifier
4. Build audit log and human-review flow
5. Add risk router
6. Add rules engine for meds / contraindications / escalation flags
7. Add secondary providers and provider abstraction
8. Only then consider fine-tuning

## Final Recommendation

This repository is a strong base for a healthcare-focused agent platform if you treat it as:

- an agent runtime kernel,
- not a ready-made healthcare product.

The most valuable reusable parts are:

- the tool execution framework,
- the query/session runtime,
- the permissions model,
- the extension architecture.

The most important new work is not “make the model smarter.” It is:

- narrow the action surface,
- enforce evidence retrieval,
- verify claims,
- route by risk,
- require human review where appropriate,
- and deploy only through provider/compliance paths suitable for healthcare.
