import { registerBundledSkill } from '../bundledSkills.js'

const SKILL_PROMPT = `Run the full MIMIC-IV clinical workflow for a patient matching the given condition.

IMPORTANT: Execute all steps yourself using the MCP tools listed below. Do NOT use the Agent tool or spawn subagents. There are no 'mimic-workflow' or 'general-purpose' agents for this task — call tools directly in sequence.

## Steps

### 1. Find a matching patient
Call \`mimic_cohort\` with a medical keyword (or ICD code if provided). Use MIMIC/ICD-9 medical terminology:
- "lung cancer" → keyword: "malignant lung"
- "heart attack" → keyword: "myocardial infarction"
- "heart failure" → keyword: "heart failure"
- "COPD" → keyword: "chronic obstructive"
- "stroke" → keyword: "cerebral infarction"
- "diabetes" → keyword: "diabetes"

Return 5 results (limit: 5), then pick the first patient with a recent admission.

### 2. Pull the patient profile
Call \`mimic_patient\` with the chosen subject_id. Note demographics, diagnoses (ICD codes), and medications.

### 3. Get recent labs
Call \`mimic_labs\` with the same subject_id (limit: 20). Note any abnormal flags.

### 4. Check for ICU stay (if clinically relevant)
If the patient has ICU diagnoses or the condition is severe, call \`mimic_icu\` to get the ICU stay summary and vitals snapshot.

### 5. Write a structured patient summary
Using the data gathered in steps 2–4, produce the following structured summary:

---

## MIMIC-IV Patient Summary

> ⚠️ MIMIC-IV de-identified research data — dates shifted, not real patients

**[Age at anchor year][Sex] with [primary diagnosis]** — [one-sentence clinical story]

### Problem List
| # | Diagnosis | ICD Code | Status |
|---|-----------|----------|--------|
| 1 | [primary] | [code] | Active |

### Current Medications
| Drug | Dose | Route | Frequency |
|------|------|-------|-----------|

### Recent Labs (abnormal flagged)
| Test | Value | Unit | Flag | Time |
|------|-------|------|------|------|

### ICU Summary (if applicable)
- Unit: [care unit], LOS: [days]
- Key vitals: HR [x], BP [x/x], SpO2 [x]%, Temp [x]°C

### One-liner for Handoff
> [Single sentence: anchor age, sex, primary diagnosis, most recent admission context]

---

### 6. Check for recruiting clinical trials
Call \`trials_search\` using the primary diagnosis as the condition. Use standard medical terms. Set recruiting_only: true, limit: 5.

For each trial returned, assess eligibility based on what is known about this patient:
- ✅ Likely eligible
- ⚠️ Uncertain — missing data or needs verification
- ❌ Likely ineligible

Present results as:

## Clinical Trial Matches

| Trial | Phase | Sponsor | Eligibility | Key Criteria |
|-------|-------|---------|-------------|--------------|

### 7. Medication safety check
Call \`drug_lookup\` for the top 3–5 medications. Then call \`drug_adverse_events\` for any high-risk or narrow-therapeutic-index drugs (e.g. warfarin, digoxin, insulin, methotrexate).

Report:
## Medication Safety Flags
- **[Drug]**: [key adverse event or interaction risk]
- (skip drugs with no notable risks)

---

## Rules
- Never invent or guess subject_ids — always call mimic_cohort first.
- MIMIC dates are shifted for de-identification; do not compare to today's date.
- Keep all tool queries to de-identified clinical terms — no names or real identifiers.
- If mimic_cohort returns 0 results, try a synonym or broader keyword before giving up.
- Call tools sequentially (cohort → patient → labs → trials → drugs). Do not spawn agents.
`

export function registerMimicWorkflowSkill(): void {
  registerBundledSkill({
    name: 'mimic-workflow',
    description: 'Run a full MIMIC-IV patient workflow: find patient by condition, pull profile and labs, summarize, match trials, check medication safety.',
    argumentHint: '<condition or ICD code>',
    whenToUse: 'Use when the user invokes /mimic-workflow or asks for a MIMIC patient demo, POC, or end-to-end clinical workflow from MIMIC data.',
    userInvocable: true,
    isEnabled: () => Boolean(process.env.HEALTHAGENT_API_BASE_URL),
    async getPromptForCommand(args) {
      let prompt = SKILL_PROMPT

      if (args) {
        prompt += `\n## Condition to search\n\n${args}`
      } else {
        prompt += '\n## Condition to search\n\nNo condition provided. Ask the user what diagnosis or condition to search for in MIMIC (e.g. "lung cancer", "heart failure", "sepsis").'
      }

      return [{ type: 'text', text: prompt }]
    },
  })
}
