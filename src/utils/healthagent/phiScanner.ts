/**
 * PHI Scanner — narrow, high-precision structural identifier detection.
 *
 * Design intent:
 * - Only fires on external tool calls (WebSearch, WebFetch, public MCP servers)
 * - Detects structured identifiers (SSN, email, phone) with low false-positive rates
 * - Does NOT attempt to detect names, dates, or ZIP codes — too many false
 *   positives in clinical text. The CLAUDE.md behavioral instruction handles those.
 * - Internal tools (EHR connectors, local tools) are excluded from scanning.
 *   Add tool names to HEALTHAGENT_INTERNAL_TOOLS (comma-separated) to exclude them.
 */

// Tools that always reach the public internet
const ALWAYS_EXTERNAL_TOOLS = new Set([
  'WebSearch',
  'WebFetch',
])

// Tools that are internal to the authorized perimeter by default
const ALWAYS_INTERNAL_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash',
  'Agent',
  'TodoWrite',
  'TodoRead',
  'NotebookRead',
  'NotebookEdit',
])

/**
 * Returns true if the tool makes calls outside the authorized perimeter.
 * MCP tools (containing '__') are treated as external by default unless
 * listed in HEALTHAGENT_INTERNAL_TOOLS.
 */
export function isExternalTool(toolName: string): boolean {
  if (ALWAYS_INTERNAL_TOOLS.has(toolName)) return false
  if (ALWAYS_EXTERNAL_TOOLS.has(toolName)) return true

  // MCP tools: external by default, unless listed in HEALTHAGENT_INTERNAL_TOOLS
  const internalList = (process.env.HEALTHAGENT_INTERNAL_TOOLS ?? '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)

  if (internalList.includes(toolName)) return false

  // Any tool with '__' in the name is an MCP tool — treat as external
  if (toolName.includes('__')) return true

  return false
}

// Narrow, high-precision patterns only. Low false-positive rate in clinical text.
const PHI_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  {
    name: 'SSN',
    // 123-45-6789 or 123 45 6789
    pattern: /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/,
  },
  {
    name: 'email',
    // Standard email — rare in clinical queries, high confidence when present
    pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/,
  },
  {
    name: 'phone',
    // US phone: (555) 123-4567 | 555-123-4567 | +1 555 123 4567
    pattern: /\b(\+1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/,
  },
]

export type PhiScanResult = {
  detected: boolean
  categories: string[]
}

/**
 * Scans text for high-confidence structural PHI identifiers.
 * Returns detected categories — never the matched content itself.
 */
export function scanForStructuralPHI(text: string): PhiScanResult {
  const categories: string[] = []
  for (const { name, pattern } of PHI_PATTERNS) {
    if (pattern.test(text)) {
      categories.push(name)
    }
  }
  return { detected: categories.length > 0, categories }
}

/**
 * Serialize a tool input object to a flat string for scanning.
 */
export function serializeToolInput(input: Record<string, unknown>): string {
  return JSON.stringify(input)
}
