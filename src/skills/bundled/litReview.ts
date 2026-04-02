import { registerBundledSkill } from '../bundledSkills.js'

const SKILL_PROMPT = `# Clinical Literature Review

## Goal
Produce a structured, evidence-based literature review for the clinical question provided. Synthesize findings from primary research and clinical practice guidelines into a concise, actionable summary.

## Steps

### 1. Parse the clinical question
Identify the PICO elements (where applicable):
- **P** — Patient/Population (disease, condition, demographics)
- **I** — Intervention (treatment, drug, procedure, test)
- **C** — Comparator (standard of care, placebo, alternative) — if stated
- **O** — Outcome (survival, response rate, safety, QoL)

Extract 2–3 PubMed search terms from P+I+O. Use MeSH/clinical terminology.

### 2. Search clinical guidelines
Call \`guidelines_search\` with the primary condition as \`condition\` and the intervention/topic as \`topic\`. Request max_results: 5. Do NOT add year_from unless the user specified a date range.

### 3. Search primary literature
Call \`pubmed_search\` focusing on high-evidence study types. Construct the query to target:
- Systematic reviews and meta-analyses: include "[pt] OR meta-analysis[pt]" or filter with "systematic review"
- RCTs if the question is about treatment efficacy
- Use 2–3 MeSH concepts joined with AND — do NOT chain more than 4 terms

Fetch abstracts for the 5–8 most relevant results using \`pubmed_fetch\` (one call with comma-joined PMIDs).

### 4. Synthesize and output

Structure the output as follows:

---

## Literature Review: [Clinical Question]

### Clinical Question
[Restate the question clearly. List PICO elements if applicable.]

### Key Guidelines
[For each relevant guideline: organization, year, headline recommendation, PubMed link. Limit to 3–5 most relevant.]

### Evidence Summary

#### High-level evidence (systematic reviews / meta-analyses)
[Summarize key findings, effect sizes, confidence, population studied. Cite PMID.]

#### Randomized controlled trials
[Summarize landmark or recent RCTs. Cite PMID.]

#### Notable gaps or limitations
[What evidence is missing, outdated, or conflicting?]

### Clinical Bottom Line
[2–4 sentence actionable summary. State level of evidence where appropriate (e.g., "Strong evidence from multiple RCTs...", "Guideline-concordant recommendation...").]

### Sources
[Numbered list of all PMIDs and guideline URLs referenced.]

---

## Rules
- PHI rule: Do NOT include any patient name, MRN, date of birth, or identifying information in any tool call. The question should be clinical and de-identified.
- Always call both guidelines_search AND pubmed_search — do not skip either.
- Do NOT call pubmed_fetch on every search result; fetch only the 5–8 most relevant PMIDs in a single call.
- If a search returns 0 results, broaden the query (fewer terms, drop the topic filter) and retry once.
- Keep the output focused on the clinical question — do not expand scope to unrelated conditions.
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
