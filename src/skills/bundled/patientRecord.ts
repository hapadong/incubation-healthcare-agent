import { registerBundledSkill } from '../bundledSkills.js'

const SKILL_PROMPT = `Manage patient records for HealthAgent. Records are persisted to ~/.healthagent/patients/.

IMPORTANT: Execute all steps yourself using the MCP tools. Do NOT use the Agent tool or spawn subagents.

## Commands

Parse the user's command from the args and execute the corresponding steps below.

---

### list
Call \`patient_list\`. Display results as a table:
| ID | Source | Demographics | Primary Diagnosis | Last Updated |
Show count. If empty, say "No patients saved yet."

---

### load <patient_id>
Use the ID exactly as provided — do not add or remove any prefix.

1. Call \`patient_load\` with the ID as-is.
2. If found: display the full patient record in a structured format (demographics, diagnoses table, medications table, recent labs). Then state clearly:
   **"Patient [id] loaded. This patient's data is now active in this session."**
3. If not found and the ID is purely numeric: the patient may not be saved yet — offer to fetch from MIMIC:
   - Call \`mimic_patient\` with the subject_id (the numeric ID)
   - Call \`mimic_labs\` with the same subject_id
   - Call \`mimic_icu\` with the same subject_id (catch errors — patient may have no ICU stay)
   - Call \`patient_save\` with id (the original ID as entered), source: "mimic", and all retrieved data structured as:
     - demographics: { subject_id, gender, age_at_anchor, anchor_year_group, race, admission_type, in_hospital_death }
     - diagnoses: array of { icd_code, icd_version, description, seq }
     - medications: array of { drug, dose, route, frequency }
     - labs: array of { label, value, unit, flag, time }
     - icu: stay summary or null
   - Display the record and confirm: **"Patient [id] fetched from MIMIC and saved."**
4. If not found and ID starts with "manual_": show available IDs from patient_load response.

---

### new <free text>
The user has provided patient information as free text (clinical note, discharge summary, pasted data, etc.).

1. Extract structured data from the free text first:
   - demographics: age, gender, any race/ethnicity mentioned
   - diagnoses: list with description; add ICD-10 code only if explicitly stated or obvious
   - medications: drug name, dose, route, frequency — only what is clearly stated
   - labs: test name, value, unit, flag — only if present in the text
   If you cannot extract at least demographics (age or gender) AND at least one diagnosis or medication, stop and tell the user the input is too sparse to save as a patient record.
2. Call \`patient_generate_id\` to get a unique ID.
3. Call \`patient_save\` passing the extracted values as actual structured arguments. Example for "67M with NSTEMI, on aspirin 81mg, hx of DM2":
   \`\`\`
   patient_save({
     id: "<generated_id>",
     source: "manual",
     demographics: { age: 67, gender: "M" },
     diagnoses: [
       { description: "NSTEMI", icd_code: "I21.9" },
       { description: "Type 2 Diabetes Mellitus", icd_code: "E11.9" }
     ],
     medications: [
       { drug: "Aspirin", dose: "81mg", route: "oral", frequency: "daily" },
       { drug: "Metoprolol", dose: "25mg", route: "oral", frequency: "BID" }
     ],
     labs: [],
     raw_text: "<original input verbatim>"
   })
   \`\`\`
   Do NOT pass empty arrays or empty objects if data was found in step 1. The structured fields must be populated with the extracted data.
4. Confirm: **"Patient saved as [id]. Use \`/patient load [id]\` to reload in future sessions."**
5. Display the structured summary.

---

### refresh <patient_id>
Only valid for MIMIC patients (source = "mimic" in the saved record).

1. Call \`patient_load\` to get the existing record and confirm source is "mimic".
2. Re-query MIMIC:
   - Call \`mimic_patient\` with the subject_id
   - Call \`mimic_labs\`
   - Call \`mimic_icu\` (catch errors)
3. Call \`patient_update\` with the fresh data.
4. Confirm: **"Patient [id] refreshed from MIMIC. Updated at [timestamp]."**
5. Display what changed if anything notable.

---

### update <patient_id>
User wants to manually edit the patient record.

1. Call \`patient_load\` to show the current record.
2. Ask the user exactly what they want to change if not specified in args.
3. Apply the change via \`patient_update\`.
4. Confirm the update.

---

## Rules
- Never modify patient IDs — use them exactly as provided by the user
- Never invent patient data — only save what comes from MIMIC tools or verbatim from user input
- When extracting from free text: if a field is not mentioned, leave it empty (empty array or empty object) — do not guess
- Do not modify existing records unless the command is explicitly refresh or update
`

export function registerPatientRecordSkill(): void {
  registerBundledSkill({
    name: 'patient',
    description: 'Manage saved patient records. Load, list, create, or refresh patient profiles persisted to disk.',
    argumentHint: 'list | load <id> | new <free text> | refresh <id> | update <id>',
    whenToUse: 'Use when the user invokes /patient to list, load, save, or refresh a patient record.',
    userInvocable: true,
    isEnabled: () => Boolean(process.env.HEALTHAGENT_API_BASE_URL),
    async getPromptForCommand(args) {
      let prompt = SKILL_PROMPT

      if (args) {
        prompt += `\n## User command\n\n/patient ${args}`
      } else {
        prompt += '\n## User command\n\nNo sub-command provided. Show usage:\n- `/patient list` — list all saved patients\n- `/patient load <id>` — load a patient by ID (or MIMIC subject_id)\n- `/patient new <free text>` — save a patient from pasted clinical notes\n- `/patient refresh <id>` — re-fetch a MIMIC patient from BigQuery\n- `/patient update <id>` — manually edit a patient record'
      }

      return [{ type: 'text', text: prompt }]
    },
  })
}
