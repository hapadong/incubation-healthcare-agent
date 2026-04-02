import { registerBundledSkill } from '../bundledSkills.js'

const SKILL_PROMPT = `Synthesize the clinical information below into a structured one-page patient summary.

## Steps

### 1. Extract key information
Read the input and identify what is present:
- Demographics (age, sex) — if provided
- Primary diagnosis and secondary conditions
- Current medications and doses
- Recent events (admissions, procedures, imaging, labs)
- Active problems and open issues
- Pending items or next steps

### 2. Normalize medications (if needed)
If drug names are abbreviated, misspelled, or unclear, call \`drug_rxnorm\` to get the normalized name. Only call for drugs you cannot confidently identify. Skip this step if all drugs are clearly named.

### 3. Code diagnoses (if needed)
If ICD-10 codes are not provided and the diagnoses are in lay terms or ambiguous, call \`icd10_search\` for the 1–3 primary diagnoses. Skip if codes are already present or diagnoses are clear standard terms.

### 4. Write the summary

---

## Patient Summary

**[Age][Sex] with [primary diagnosis]** — [one sentence capturing the key clinical story]

---

### Problem List
| # | Diagnosis | ICD-10 | Status |
|---|-----------|--------|--------|
| 1 | [primary] | ... | Active |
| 2 | [secondary] | ... | Active / Chronic / Resolved |

### Current Medications
| Drug | Dose / Frequency | Indication |
|------|-----------------|------------|
| ... | ... | ... |

### Clinical Timeline
- **[Date or relative time]** — [event: admission, procedure, key result, diagnosis change]
- (most recent first)

### Active Issues
1. [Issue] — [brief status and plan if mentioned]
2. ...

### Pending / Follow-up
- [ ] [Pending result, referral, or scheduled action]

### One-liner for Handoff
> [Single sentence a covering clinician can read in 5 seconds: age, sex, diagnosis, current status, immediate concern]

---

## Rules
- Keep the summary concise — this is a one-pager, not a full note.
- Only call tools when the input is ambiguous or incomplete — do not call tools for clearly stated information.
- If critical information is missing (e.g. no medications listed, no diagnosis), note it explicitly under the relevant section rather than leaving it blank.
- Strip any identifiers before tool calls — searches use clinical terms only.
- If the input is too sparse to produce a meaningful summary, ask the user for the missing details rather than generating a mostly empty template.
`

export function registerPatientSummarySkill(): void {
  registerBundledSkill({
    name: 'patient-summary',
    description: 'Synthesize clinical notes or patient data into a structured one-page summary.',
    argumentHint: '<clinical notes or patient data>',
    whenToUse: 'Use when the user invokes /patient-summary or asks to summarize a patient case.',
    userInvocable: true,
    isEnabled: () => Boolean(process.env.HEALTHAGENT_API_BASE_URL),
    async getPromptForCommand(args) {
      let prompt = SKILL_PROMPT

      if (args) {
        prompt += `\n## Patient Data\n\n${args}`
      } else {
        prompt +=
          '\n## Patient Data\n\nNo data provided. Ask the user to paste the clinical note, discharge summary, or patient information they want summarized.'
      }

      return [{ type: 'text', text: prompt }]
    },
  })
}
