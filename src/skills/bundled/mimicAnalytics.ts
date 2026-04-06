import { registerBundledSkill } from '../bundledSkills.js'

const SKILL_PROMPT = `Answer the user's analytics question using MIMIC-IV data.

IMPORTANT: Execute all steps yourself using the MCP tools listed below (mimic_sql, mimic_cohort, etc.). Do NOT use the Agent tool or attempt to spawn a subagent. There is no 'mimic-analytics' agent type — you are the agent. Call tools directly.

## Your approach

### 1. Understand the question
Identify what the user wants:
- **Descriptive stats**: counts, rates, means, medians, distributions
- **Cohort analysis**: filter patients by diagnosis/age/admission type, then aggregate
- **Trend analysis**: values over time (labs, vitals, admissions)
- **Comparison**: two groups side by side (e.g. survivors vs non-survivors, ICU vs floor)
- **Individual patient**: drill into a specific patient (use mimic_cohort → mimic_patient/labs/icu)

### 2. Plan the query
Think through:
- Which MIMIC tables are needed
- What joins are required
- How to aggregate or pivot the data
- Whether multiple queries are needed (run them one at a time)

### 3. Execute with mimic_sql
Write and run BigQuery SQL. Call \`mimic_sql\` with the query.
- All table references must be fully qualified with backticks, e.g. \`physionet-data.mimiciv_3_1_hosp.patients\`
- Use DATETIME_DIFF for date math (columns like admittime/dischtime are DATETIME, not TIMESTAMP)
- Use SAFE_DIVIDE to avoid division-by-zero
- For mortality rate: AVG(hospital_expire_flag) or SUM/COUNT
- For LOS: los column in icustays (days, float), or DATETIME_DIFF(dischtime, admittime, HOUR)/24.0 for admissions
- anchor_year_group is a STRING like "2010 - 2019" — don't cast it to INT
- Only SELECT/WITH allowed; results capped at 1000 rows

If a query fails, read the error carefully and fix the SQL before retrying.

### 4. Interpret the results
Summarize what the numbers mean clinically. Don't just repeat the table — add context:
- Is a mortality rate high or low for this condition?
- Is a median LOS typical?
- Are there notable outliers or unexpected patterns?

### 5. Present a clean summary
Use markdown tables for tabular data. Highlight the key finding in bold.

### 6. Generate visualization code (always do this for any numeric results)
After presenting results, generate a self-contained Python script that:
- Uses \`pandas\` and \`matplotlib\` (or \`seaborn\` for distribution plots)
- Hardcodes the result data as a Python dict or list (copy the actual query results in)
- Produces a clear, labeled plot appropriate for the data type:
  - Bar chart → category comparisons, counts by group
  - Histogram → distributions (age, LOS, lab values)
  - Line chart → time trends
  - Scatter → correlations
  - Box plot → distributions with outliers (LOS, lab values by group)
- Saves the figure to \`mimic_plot.png\` and also calls \`plt.show()\`
- Uses a clean style: \`plt.style.use('seaborn-v0_8-whitegrid')\`
- Includes a title and axis labels with units

Format the script in a fenced \`\`\`python code block so the user can copy and run it.

## Rules
- Never fabricate data — only use what mimic_sql returns
- MIMIC dates are shifted; never compare to today's date
- Keep queries focused — avoid full table scans where possible (filter by subject_id, hadm_id, or itemid)
- For lab analysis: join labevents with d_labitems on itemid to get the label; filter by label or itemid
- Common itemids: Heart Rate=220045, SpO2=220277, Respiratory Rate=220210, Temp °C=223762, Systolic BP=220050
- For diagnosis queries: first call \`icd10_search\` to identify the parent ICD category prefix (e.g. sepsis → A40%, A41%; lung cancer → C34%). Use LIKE prefix patterns in WHERE — never a hand-picked IN() list of leaf codes, which misses most patients. Always cover both ICD-9 and ICD-10 in MIMIC (e.g. sepsis ICD-9: 038%, 99591, 99592). Join diagnoses_icd with d_icd_diagnoses on (icd_code, icd_version) to get long_title.
- For molecular markers or terms without a clean ICD code, use \`LOWER(di.long_title) LIKE '%term%'\` in the WHERE clause
- If the question is ambiguous, state your interpretation before running the query
`

export function registerMimicAnalyticsSkill(): void {
  registerBundledSkill({
    name: 'mimic-analytics',
    description: 'Answer data analytics questions about MIMIC-IV using natural language. Generates and runs BigQuery SQL, interprets results, and produces Python visualization code.',
    argumentHint: '<analytics question>',
    whenToUse: 'Use when the user invokes /mimic-analytics or asks a data question about MIMIC-IV (statistics, distributions, cohort analysis, trends, comparisons).',
    userInvocable: true,
    isEnabled: () => Boolean(process.env.HEALTHAGENT_API_BASE_URL),
    async getPromptForCommand(args) {
      let prompt = SKILL_PROMPT

      if (args) {
        prompt += `\n## Question\n\n${args}`
      } else {
        prompt +=
          '\n## Question\n\nNo question provided. Ask the user what they want to analyze from MIMIC-IV. Examples:\n- "What is the mortality rate for sepsis patients by age group?"\n- "Show the distribution of ICU length of stay"\n- "Compare creatinine levels between survivors and non-survivors"\n- "What are the top 10 diagnoses in the dataset?"'
      }

      return [{ type: 'text', text: prompt }]
    },
  })
}
