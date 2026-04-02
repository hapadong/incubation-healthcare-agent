# HealthAgent Development Rules

## CRITICAL: Never Touch dist/cli.cjs

**NEVER read, grep, sed, patch, or modify `dist/cli.cjs` or any file in `dist/`.**

- `dist/cli.cjs` is an 18MB compiled bundle — reading it wastes enormous amounts of tokens
- All changes must be made to source files under `src/`
- The user triggers the build manually (`npm run build` or equivalent)
- After a build, never read the dist file to verify — trust the source

## Workflow

1. Edit source files in `src/` only
2. Tell the user what was changed and why
3. User runs the build themselves
4. User tests the result

## Git Rules

- **Never commit or push without explicit user instruction.** Do not auto-commit after edits.
- **No co-author lines in commits.** Do not add `Co-Authored-By` or any Claude/AI attribution to commit messages. Undercover mode — commits appear as the user's own work.

## Token-Saving Rules

- Work only on source files — they are small and targeted
- Read a file once before editing it, then edit it directly
- Use `Grep` with precise patterns instead of reading large file sections
- Batch all changes to a file into a single edit pass
- Do not run the build, do not verify the build output
