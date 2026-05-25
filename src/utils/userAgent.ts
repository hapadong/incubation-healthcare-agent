/**
 * User-Agent string helpers.
 *
 * Kept dependency-free so SDK-bundled code (bridge, cli/transports) can
 * import without pulling in auth.ts and its transitive dependency tree.
 */

import { HA_VERSION } from '../constants/version.js'

export function getClaudeCodeUserAgent(): string {
  return `health-agent/${HA_VERSION}`
}
