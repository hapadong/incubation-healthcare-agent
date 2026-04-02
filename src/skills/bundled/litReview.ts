import { registerBundledSkill } from '../bundledSkills.js'

const SKILL_PROMPT = `Search the medical literature and practice guidelines for the topic below, then write a structured research summary.

## Search plan
1. Call \`guidelines_search\` — use the primary condition as \`condition\` and the treatment/topic as \`topic\` (max_results: 5). Omit year_from unless the user gave a date range.
2. Call \`pubmed_search\` — target systematic reviews and clinical trials. Use 2–3 MeSH/clinical terms joined with AND; do not chain more than 4 terms. Sort by relevance.
3. Call \`pubmed_fetch\` once with the 5–8 most relevant PMIDs (comma-joined). Do not fetch every result.
4. If any search returns 0 results, retry with fewer terms.

## Output format

### [Topic]
**Population / question:** [brief restatement]

**Guidelines**
- [Organization, year] — [headline recommendation] — [URL]

**Research findings**
- [Study type, author/year, key result, PMID]
- (repeat for each relevant study)

**Gaps and limitations**
[What is missing, conflicting, or uncertain in the literature]

**Summary**
[3–5 sentences synthesizing the overall state of evidence]

**References**
[numbered list of PMIDs and guideline URLs]
`

export function registerLitReviewSkill(): void {
  registerBundledSkill({
    name: 'lit-review',
    description:
      'Structured clinical literature review. Searches PubMed for systematic reviews, meta-analyses, and RCTs, then cross-references clinical practice guidelines (ASCO, ESMO, AHA, ADA, etc.) to produce an evidence synthesis with a clinical bottom line.',
    argumentHint: '<clinical question>',
    whenToUse:
      'Use when the user asks for a literature review, evidence summary, or wants to know what the evidence says about a treatment, drug, procedure, or clinical question.',
    userInvocable: true,
    isEnabled: () => Boolean(process.env.HEALTHAGENT_API_BASE_URL),
    async getPromptForCommand(args) {
      let prompt = SKILL_PROMPT

      if (args) {
        prompt += `\n## Clinical Question\n\n${args}`
      } else {
        prompt +=
          '\n## Clinical Question\n\nNo question was provided. Ask the user to specify the clinical question they want reviewed (e.g., "first-line immunotherapy for stage IV NSCLC").'
      }

      return [{ type: 'text', text: prompt }]
    },
  })
}
