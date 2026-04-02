import { registerBundledSkill } from '../bundledSkills.js'

const SKILL_PROMPT = `Review the medication list below and produce a structured reconciliation report.

## Steps

### 1. Parse the medication list
Extract each medication with:
- Drug name (brand or generic)
- Dose and frequency (if provided)
- Indication (if provided)

### 2. Look up each drug
Call \`drug_lookup\` once per unique drug — do NOT call it multiple times for the same drug. Collect:
- Generic name, drug class
- Contraindications and warnings
- Known drug interactions section

### 3. Check for active recalls
For any drug flagged with warnings or that is high-risk (anticoagulants, chemotherapy, immunosuppressants, narrow therapeutic index drugs), call \`drug_recalls\` to check for active FDA recalls.

### 4. Analyze the list as a whole
After looking up all drugs, reason across the full list to identify:

**Duplicate therapy** — two drugs from the same class treating the same condition (e.g. two ACE inhibitors, two SSRIs)

**Drug-drug interactions** — use the interaction sections from the labels to flag pairs. Focus on clinically significant interactions (QT prolongation, serotonin syndrome, bleeding risk, nephrotoxicity, etc.)

**High-risk drugs** — flag drugs requiring special monitoring (warfarin, digoxin, lithium, immunosuppressants, opioids, insulin)

**Recall alerts** — any active FDA recalls found in step 3

### 5. Output

---

## Medication Reconciliation Report

**Medications reviewed:** [count]

### Drug Summary
| # | Drug | Generic | Class | Dose/Freq |
|---|------|---------|-------|-----------|
| 1 | ... | ... | ... | ... |

### Findings

#### Duplicate Therapy
- [Drug A] and [Drug B] — both [class], both used for [indication]. Consider reviewing necessity of both.

#### Drug-Drug Interactions
- ⚠️ **[Drug A] + [Drug B]** — [interaction description, mechanism, clinical risk]. Recommend [action].

#### High-Risk Drugs Requiring Monitoring
- 🔴 [Drug] — [why high-risk, what to monitor, frequency]

#### Recall Alerts
- 🚨 [Drug] — [recall reason, classification, recalling firm]

#### No Issues Found
- [List drugs with no flags]

### Recommendations
[3–5 concise action items for the clinical team, ordered by priority]

---

## Rules
- Call \`drug_lookup\` once per drug — the tool tries brand/generic/substance internally, do not retry.
- Only call \`drug_recalls\` for high-risk or flagged drugs, not every drug on the list.
- If a drug is not found in the FDA database, note it and continue — do not stop.
- Keep the analysis focused on clinically actionable findings. Do not list minor or theoretical interactions.
- All searches must use drug names only — no patient identifiers.
`

export function registerMedReconSkill(): void {
  registerBundledSkill({
    name: 'med-recon',
    description: 'Review a medication list for interactions, duplicates, recalls, and high-risk drugs.',
    argumentHint: '<medication list>',
    whenToUse: 'Use when the user invokes /med-recon or provides a list of medications to review.',
    userInvocable: true,
    isEnabled: () => Boolean(process.env.HEALTHAGENT_API_BASE_URL),
    async getPromptForCommand(args) {
      let prompt = SKILL_PROMPT

      if (args) {
        prompt += `\n## Medication List\n\n${args}`
      } else {
        prompt +=
          '\n## Medication List\n\nNo medications provided. Ask the user to list the medications (name, dose, frequency) they want reviewed.'
      }

      return [{ type: 'text', text: prompt }]
    },
  })
}
