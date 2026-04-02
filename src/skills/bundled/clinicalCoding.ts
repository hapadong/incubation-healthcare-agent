import { registerBundledSkill } from '../bundledSkills.js'

const SKILL_PROMPT = `Extract diagnoses, procedures, and lab orders from the clinical text below and suggest appropriate codes.

## Steps

### 1. Extract codeable concepts
Read the clinical text and identify:
- **Diagnoses / conditions** — primary and secondary
- **Procedures** — surgical, therapeutic, diagnostic
- **Lab / observation orders** — tests, vitals, assessments

For each diagnosis, translate lay terms to clinical terminology before searching:
- "heart attack" → "myocardial infarction"
- "cancer" → "malignant neoplasm" + specific site
- "stroke" → "cerebral infarction"
- "kidney failure" → "renal failure" or "chronic kidney disease"

### 2. Search ICD-10 codes
For each diagnosis or procedure, call \`icd10_search\` with the clinical term. Request max_results: 5.
- Use specific terms first (e.g. "myocardial infarction anterior wall")
- If no results, broaden (e.g. "myocardial infarction")
- For categories, search by code prefix (e.g. "E11" for type 2 diabetes)

### 3. Search LOINC codes (if labs present)
For each lab test or clinical observation, call \`loinc_search\`. Request max_results: 5.
- Use standard lab names (e.g. "hemoglobin A1c", "serum creatinine", "troponin I")
- Filter by category: LAB for tests, CLINICAL for vitals/assessments

### 4. Select best codes
For each concept, choose the most specific matching code. Prefer:
- Codes that capture laterality, chronicity, severity where documented
- Confirmed diagnoses over "suspected" unless text says otherwise
- The most specific subdivision over a parent category code

### 5. Output

---

## Clinical Coding Summary

**Source:** [brief description of the clinical text]

### Diagnoses — ICD-10-CM

| # | Concept (from text) | ICD-10 Code | Description | Confidence |
|---|---------------------|-------------|-------------|------------|
| 1 | ... | ... | ... | ✅ High / ⚠️ Review |

### Procedures — ICD-10-PCS or CPT note
| # | Concept (from text) | ICD-10 Code | Description | Confidence |
|---|---------------------|-------------|-------------|------------|

### Lab / Observation Orders — LOINC
| # | Test (from text) | LOINC | Long name | Class |
|---|-----------------|-------|-----------|-------|

### Coding Notes
- [Flag any ambiguous concepts where the coder should seek clarification]
- [Note if a more specific code requires additional documentation]
- [List any concepts found but not coded, with reason]

---

## Rules
- Search for each concept separately — do not combine multiple diagnoses in one search.
- Mark confidence ⚠️ Review when: the text is ambiguous, multiple codes are plausible, or specificity requires clarification.
- Do not fabricate codes — only suggest codes returned by the search tools.
- All searches use clinical terms only — strip any patient name, date of birth, or identifiers from the input before searching.
`

export function registerClinicalCodingSkill(): void {
  registerBundledSkill({
    name: 'clinical-coding',
    description: 'Extract diagnoses and procedures from clinical text and suggest ICD-10 and LOINC codes.',
    argumentHint: '<clinical note or diagnosis list>',
    whenToUse: 'Use when the user invokes /clinical-coding or asks for ICD-10 or LOINC codes from clinical text.',
    userInvocable: true,
    isEnabled: () => Boolean(process.env.HEALTHAGENT_API_BASE_URL),
    async getPromptForCommand(args) {
      let prompt = SKILL_PROMPT

      if (args) {
        prompt += `\n## Clinical Text\n\n${args}`
      } else {
        prompt +=
          '\n## Clinical Text\n\nNo text provided. Ask the user to paste the clinical note, diagnosis list, or procedure description they want coded.'
      }

      return [{ type: 'text', text: prompt }]
    },
  })
}
