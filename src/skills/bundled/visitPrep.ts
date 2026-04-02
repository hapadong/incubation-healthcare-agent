import { registerBundledSkill } from '../bundledSkills.js'

const SKILL_PROMPT = `Prepare a structured visit checklist for the patient encounter described below.

## Steps

### 1. Parse the visit context
Extract from the user's input:
- **Diagnosis / condition**: primary and any relevant secondary conditions
- **Stage / severity**: if applicable
- **Current treatment**: drugs, regimen, cycle number, duration
- **Reason for visit**: follow-up, toxicity review, restaging, new symptom, etc.
- **Key concerns**: anything the user flagged as important

### 2. Pull guideline-based monitoring requirements
Call \`guidelines_search\` with the condition and visit type as topic (e.g. "follow-up", "toxicity monitoring", "response assessment"). Request max_results: 3.

This grounds the checklist in evidence — guidelines specify what should be assessed at each visit type.

### 3. Check current treatment drugs
For each active drug or regimen (up to 3 key drugs), call \`drug_adverse_events\` to get the top reported adverse reactions. This tells you what side effects to actively probe during the visit.

Skip this step if no specific drugs are mentioned.

### 4. Check for relevant open trials (optional)
If the visit context suggests the patient may be a candidate for a trial (e.g. progression, second-line, biomarker-positive), call \`trials_search\` with condition and status RECRUITING. Limit to 3 results.

Skip this step if the visit is routine follow-up with no change in status.

### 5. Suggest standard assessments
Call \`loinc_search\` for 1–2 key lab panels relevant to the condition and treatment (e.g. "complete blood count", "liver function", "creatinine"). This gives standard LOINC codes for any orders.

### 6. Synthesize the checklist

---

## Visit Preparation — [Condition] [Visit Type]

**Patient context:** [one-line summary]
**Prepared:** [today's date if known, otherwise omit]

---

### Before the Visit
- [ ] Review most recent labs: [specific tests relevant to condition/treatment]
- [ ] Review imaging / pathology if applicable: [what to look for]
- [ ] Check medication list for changes since last visit

---

### During the Visit

#### Symptom & Toxicity Assessment
- [ ] [Symptom/toxicity to ask about — grounded in drug adverse events and guidelines]
- [ ] (repeat for each key item)

#### Physical Exam Focus
- [ ] [Exam findings relevant to condition and treatment]

#### Performance Status
- [ ] Document ECOG / KPS

---

### Orders to Consider
| Test | LOINC | Rationale |
|------|-------|-----------|
| ... | ... | ... |

---

### Guideline-Concordant Actions
- [ ] [Action item from guideline — e.g. restaging scan timing, referral, biomarker testing]
- [ ] (repeat)

---

### Trials to Discuss
- [Trial name, NCT ID, phase, relevance to this patient] — or "None identified" if step 4 was skipped

---

### Topics to Cover with Patient
- [ ] [Treatment response / status update]
- [ ] [Side effect management]
- [ ] [Next steps / plan]
- [ ] [Any trial or alternative options if applicable]

---

### Coding Suggestions
- Primary diagnosis ICD-10: [suggest based on condition — use your knowledge, do not call icd10_search]
- Visit type: [follow-up = Z09 or condition-specific follow-up code]

---

## Rules
- Ground every checklist item in the guideline results or drug adverse event data — avoid generic filler.
- If guidelines return no results, use your knowledge of standard-of-care monitoring for the condition.
- Keep the checklist concise and action-oriented — each item should be a specific task, not a general reminder.
- All tool calls use clinical/drug terms only — no patient identifiers.
`

export function registerVisitPrepSkill(): void {
  registerBundledSkill({
    name: 'visit-prep',
    description: 'Generate a structured pre-visit checklist for a patient encounter.',
    argumentHint: '<patient context and reason for visit>',
    whenToUse: 'Use when the user invokes /visit-prep or asks to prepare for a patient visit.',
    userInvocable: true,
    isEnabled: () => Boolean(process.env.HEALTHAGENT_API_BASE_URL),
    async getPromptForCommand(args) {
      let prompt = SKILL_PROMPT

      if (args) {
        prompt += `\n## Visit Context\n\n${args}`
      } else {
        prompt +=
          '\n## Visit Context\n\nNo context provided. Ask the user for: diagnosis, current treatment, reason for visit, and any specific concerns.'
      }

      return [{ type: 'text', text: prompt }]
    },
  })
}
