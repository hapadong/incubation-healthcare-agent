import { registerBundledSkill } from '../bundledSkills.js'

const SKILL_PROMPT = `Run the full MIMIC-IV clinical workflow for a patient matching the given condition.

IMPORTANT: Execute all steps yourself using the MCP tools listed below. Do NOT use the Agent tool or spawn subagents. There are no 'mimic-workflow' or 'general-purpose' agents for this task — call tools directly in sequence.

## Steps

### 1. Find a matching patient (ICD-first approach)

**Step 1a — Resolve ICD code prefixes**
Call \`icd10_search\` with the primary condition. From the results, identify the **parent category prefix** — not individual leaf codes.

Critical rules for reading icd10_search results:
- Many conditions span a whole letter-number block. Use the common prefix with LIKE, not a hand-picked IN() list.
- Example: sepsis → A40.x and A41.x (not individual rare variants like A02.1 or A22.7). Prefix: \`'A40%'\`, \`'A41%'\`, plus severe sepsis R65.x → \`'R65%'\`
- Example: lung cancer → C34.x → prefix \`'C34%'\`
- Example: heart failure → I50.x → prefix \`'I50%'\`
- If icd10_search returns only very specific or rare subtypes, widen to the parent block.

If the condition has a secondary component (mutation, comorbidity, stage), call \`icd10_search\` again.

**Step 1b — Query MIMIC by ICD prefix using SQL**
MIMIC-IV contains both ICD-9 and ICD-10 codes. Always cover both versions.

Common ICD-9 equivalents to remember:
- Sepsis → ICD-9: \`038.x\`, \`995.91\`, \`995.92\`
- Lung cancer → ICD-9: \`162.x\`
- Heart failure → ICD-9: \`428.x\`
- COPD → ICD-9: \`491.x\`, \`492.x\`, \`496\`
- Diabetes → ICD-9: \`250.x\`
- Stroke → ICD-9: \`434.x\`, \`436\`

Use \`LIKE\` prefix patterns (not exact IN lists) so all subtypes are captured:
\`\`\`sql
SELECT DISTINCT d.subject_id, d.hadm_id, di.long_title, d.icd_code, d.icd_version
FROM \`physionet-data.mimiciv_3_1_hosp.diagnoses_icd\` d
JOIN \`physionet-data.mimiciv_3_1_hosp.d_icd_diagnoses\` di
  ON d.icd_code = di.icd_code AND d.icd_version = di.icd_version
WHERE (
  (d.icd_version = 10 AND (d.icd_code LIKE 'A40%' OR d.icd_code LIKE 'A41%' OR d.icd_code LIKE 'R65%'))
  OR
  (d.icd_version = 9  AND (d.icd_code LIKE '038%' OR d.icd_code LIKE '99591' OR d.icd_code LIKE '99592'))
)
LIMIT 10
\`\`\`

For compound conditions (e.g. NSCLC **and** EGFR mutation — require both on the same patient):
\`\`\`sql
SELECT DISTINCT d1.subject_id, d1.hadm_id
FROM \`physionet-data.mimiciv_3_1_hosp.diagnoses_icd\` d1
JOIN \`physionet-data.mimiciv_3_1_hosp.diagnoses_icd\` d2
  ON d1.subject_id = d2.subject_id AND d1.hadm_id = d2.hadm_id
WHERE (d1.icd_version = 10 AND d1.icd_code LIKE 'C34%')   -- primary: lung cancer
  AND (d2.icd_version = 10 AND d2.icd_code LIKE 'Z15%')   -- secondary: genetic susceptibility
LIMIT 10
\`\`\`

For molecular markers or terms without a clean ICD code, search long_title descriptions:
\`\`\`sql
SELECT DISTINCT d.subject_id, d.hadm_id, di.long_title, d.icd_code
FROM \`physionet-data.mimiciv_3_1_hosp.diagnoses_icd\` d
JOIN \`physionet-data.mimiciv_3_1_hosp.d_icd_diagnoses\` di
  ON d.icd_code = di.icd_code AND d.icd_version = di.icd_version
WHERE LOWER(di.long_title) LIKE '%egfr%'
   OR LOWER(di.long_title) LIKE '%epidermal growth factor%'
LIMIT 10
\`\`\`

**Step 1c — Fall back to keyword only if SQL returns 0 results**
If the prefix SQL returns nothing, try broadening the prefix one level, then fall back to \`mimic_cohort\` keyword search as a last resort.

Pick the first patient returned with a valid subject_id.

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
- Always use the ICD-first approach (icd10_search → mimic_sql). Only fall back to mimic_cohort if SQL returns 0 results.
- Never invent or guess subject_ids — always derive them from tool results.
- MIMIC dates are shifted for de-identification; do not compare to today's date.
- Keep all tool queries to de-identified clinical terms — no names or real identifiers.
- For compound conditions (disease + mutation/marker), use a JOIN query to require both on the same patient.
- Call tools sequentially. Do not spawn agents.
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
