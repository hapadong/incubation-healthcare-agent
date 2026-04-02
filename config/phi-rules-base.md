# Verity Health Agent — PHI Rules Reference

This document defines the canonical PHI policy for all Verity Health Agent deployments.
Copy the relevant section into your deployment's CLAUDE.md.

---

## Core Principle

**PHI may flow freely within the authorized perimeter. The agent's responsibility is to enforce the perimeter boundary — not to block PHI from itself.**

The authorized perimeter is the set of systems covered by your organization's HIPAA policies and BAAs:
- The inference model endpoint (on-prem, or cloud with active BAA)
- The EHR system and its authorized connectors
- The audit log store (on-prem, encrypted, access-controlled)
- The clinician's authenticated workstation on the hospital network

PHI may move between any systems inside this perimeter. PHI must never cross outside it.

---

## Two Deployment Modes

### Mode A — No EHR Integration (Chatbot / Reference Tool)

The agent has no connection to live patient data. All clinical context is typed by the user.

**PHI rules for Mode A:**
- Do not ask the user to provide PHI. De-identified clinical descriptions are sufficient for reference tasks.
- If the user provides PHI (name, DOB, MRN, or other direct identifiers), stop and ask them to rephrase using de-identified terms. You do not need the patient's identity to answer clinical questions.
- This is not a hard compliance wall — it is a habit-formation rule. Working with de-identified descriptions also protects against PHI appearing in logs, transcripts, and external tool calls.

**Example:** Instead of "my patient John Smith, DOB 1952-03-14, on warfarin..." → "a 72-year-old male on warfarin..."

---

### Mode B — EHR-Integrated Workflow Agent

The agent receives structured patient data from an authorized EHR system via MCP tools. PHI flows into the model's context as part of the task (e.g., drafting a discharge summary, generating a care plan, summarizing a visit).

**PHI rules for Mode B:**
- PHI received from authorized EHR MCP tools may be used in context to complete the task.
- All PHI-bearing operations must generate an audit log entry (tool name, timestamp, user, patient reference — not full PHI content in the log).
- Apply minimum necessary: only request from the EHR the fields required for the specific task. Do not pull full patient records when only the medication list is needed.
- When the task is complete, do not retain PHI in any persistent store (memory files, transcript exports) unless the target system is within the authorized perimeter.

---

## Perimeter Boundary Rules (Both Modes)

These rules apply regardless of deployment mode:

### 1. No PHI in external tool calls
Before calling any tool that reaches outside the authorized perimeter (web search, external APIs, external MCP servers, public databases), strip or de-identify all PHI from the query.

- Safe: `drug_interactions("warfarin", "aspirin")`
- Unsafe: `web_search("warfarin aspirin interaction for John Smith DOB 1952")`

The agent must inspect any query it is about to send externally and remove identifiers before sending.

### 2. Model endpoint verification
- On-premises model (Ollama, vLLM on hospital hardware): PHI in prompts stays on hospital infrastructure.
- Azure OpenAI or other cloud endpoint: PHI may only flow to this endpoint if an active BAA with the provider is confirmed. If BAA status is unknown, treat the endpoint as outside the perimeter.
- Anthropic API (api.anthropic.com): Outside the perimeter unless a BAA is in place. Not the default for this deployment.

### 3. Audit trail
Every PHI-bearing operation must be logged:
- What tool was called
- By which user (authenticated identity)
- At what time
- Against which patient reference (encounter ID, not name)

The audit log itself must not contain raw PHI — use patient reference IDs, not names or DOBs.

### 4. Access control
The agent must not process PHI for a user who has not been authenticated and authorized for that patient's record. Authentication is the responsibility of the EHR integration layer, not the agent — but the agent should not proceed if no authenticated user context is present in a Mode B workflow.

### 5. External search and PHI
Web search tools (Brave, Tavily, PubMed, etc.) are external services outside the perimeter. Queries sent to them must be general clinical questions, never patient-specific. If answering a question requires both PHI context and external lookup, the agent must decompose the task: look up the general clinical question externally using de-identified terms, then apply the result to the PHI context locally.

---

## Summary Table

| Rule | Mode A | Mode B |
|---|---|---|
| PHI may enter model context | No — ask user to de-identify | Yes — from authorized EHR MCP only |
| Audit log required | Recommended | Required |
| Minimum necessary | N/A | Required |
| External tool calls | Must not contain PHI | Must strip PHI before sending |
| BAA verification | Required if using cloud endpoint | Required |
| Session isolation | Recommended | Required |
