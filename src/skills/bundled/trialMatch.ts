import { registerBundledSkill } from '../bundledSkills.js'

const SKILL_PROMPT = `Find clinical trials that match the patient profile below and evaluate eligibility for each candidate.

## Steps

### 1. Parse the patient profile
Extract these fields from the user's input (use "unknown" if not provided):
- **Diagnosis**: primary condition and histology
- **Stage / extent**: e.g. stage IV, metastatic, locally advanced
- **Biomarkers**: mutations, expression levels, receptor status
- **ECOG performance status**: 0–4 (if mentioned)
- **Prior treatments**: therapies already received
- **Location**: city/country (for geographic filtering)
- **Key exclusions**: comorbidities or contraindications that may disqualify

### 2. Search for trials
Call \`trials_search\` with:
- \`condition\`: primary diagnosis
- \`intervention\`: most relevant drug class or approach (optional)
- \`status\`: "RECRUITING" (always filter to recruiting only)
- \`max_results\`: 10

If the first search returns fewer than 3 results, retry with a broader condition term.

### 3. Fetch eligibility criteria
Call \`trial_detail\` for the 3–5 most relevant trials (based on title/phase match to the patient). Fetch them in parallel if possible — do NOT fetch all 10.

### 4. Evaluate each trial
For each trial fetched, go through its inclusion and exclusion criteria one by one and check them against the patient profile:

| Criterion | Requirement | Patient | Verdict |
|-----------|-------------|---------|---------|
| e.g. EGFR mutation | Required positive | Wild-type | ❌ Excluded |
| e.g. ECOG | 0–2 | Unknown | ⚠️ Uncertain |
| e.g. Prior platinum | No prior platinum | Received | ❌ Excluded |

Then assign an overall verdict per trial:
- ✅ **Likely eligible** — all known criteria met
- ⚠️ **Uncertain** — one or more criteria unknown or borderline
- ❌ **Excluded** — at least one hard exclusion criterion fails

### 5. Output

---

## Trial Match Results

**Patient summary:** [one-line profile recap]

### Ranked Candidates

#### 1. [Trial title] — [NCT ID]
**Phase:** | **Status:** | **Sponsor:**
**Overall verdict:** ✅ / ⚠️ / ❌

| Criterion | Requirement | Patient | Verdict |
|-----------|-------------|---------|---------|
| ... | ... | ... | ... |

**Notes:** [any caveats, contact info, trial URL]

---
(repeat for each trial, best match first)

### Not evaluated
[List trials found but not fetched, with NCT ID and reason skipped]

---

## Rules
- Only evaluate trials with status RECRUITING — skip completed or terminated trials.
- If the patient profile is missing critical fields (stage, key biomarkers), note what information would resolve uncertain verdicts.
- Do not fetch more than 5 trial details — prioritize by phase (prefer phase 2/3) and relevance to the patient's specific profile.
- Keep all searches de-identified — use clinical terms only, no personal identifiers.
`

export function registerTrialMatchSkill(): void {
  registerBundledSkill({
    name: 'trial-match',
    description: 'Find and evaluate clinical trials against a patient profile.',
    argumentHint: '<patient profile>',
    whenToUse: 'Use when the user invokes /trial-match or asks to find matching trials for a patient.',
    userInvocable: true,
    isEnabled: () => Boolean(process.env.HEALTHAGENT_API_BASE_URL),
    async getPromptForCommand(args) {
      let prompt = SKILL_PROMPT

      if (args) {
        prompt += `\n## Patient Profile\n\n${args}`
      } else {
        prompt +=
          '\n## Patient Profile\n\nNo profile provided. Ask the user for: diagnosis, stage, key biomarkers, prior treatments, ECOG status, and location.'
      }

      return [{ type: 'text', text: prompt }]
    },
  })
}
