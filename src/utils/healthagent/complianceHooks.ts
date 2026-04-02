/**
 * Verity Health Agent — Compliance Hooks
 *
 * Registered once at session startup via registerComplianceHooks().
 * Fires for ALL tool calls in the session — main agent and any subagent —
 * with no per-agent wiring required.
 *
 * PreToolUse: scans external tool calls for structural PHI (SSN, email, phone)
 * PostToolUse: logs every tool call to the local append-only audit trail
 */

import { getSessionId } from '../../bootstrap/state.js'
import { registerHookCallbacks } from '../../bootstrap/state.js'
import type { HookCallback } from '../../types/hooks.js'
import type { HookInput, HookJSONOutput } from '../../entrypoints/agentSdkTypes.js'
import {
  isExternalTool,
  scanForStructuralPHI,
  serializeToolInput,
} from './phiScanner.js'
import { buildAuditEntry, logAuditEntry } from './auditLogger.js'

function getSessionIdSafe(): string {
  try {
    return getSessionId() ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

const preToolUseHook: HookCallback = {
  type: 'callback',
  // NOT internal: true — blocking hooks must go through the slow path
  // where return values are processed. internal:true routes to the fast
  // path which ignores return values and cannot block tool calls.
  timeout: 5,
  async callback(input: HookInput): Promise<HookJSONOutput> {
    if (input.hook_event_name !== 'PreToolUse') return {}

    const { tool_name, tool_input } = input
    if (!isExternalTool(tool_name)) return {}

    const inputText = serializeToolInput(tool_input as Record<string, unknown>)
    const scan = scanForStructuralPHI(inputText)

    if (scan.detected) {
      logAuditEntry(
        buildAuditEntry({
          sessionId: getSessionIdSafe(),
          toolName: tool_name,
          toolInput: tool_input as Record<string, unknown>,
          external: true,
          phiBlocked: true,
          phiCategories: scan.categories,
          outcome: 'blocked',
        }),
      )

      return {
        decision: 'block',
        reason: `PHI detected in external call (${scan.categories.join(', ')}). Re-phrase using clinical descriptors only (e.g. "a 65-year-old male with NSCLC" not a named patient).`,
      }
    }

    return {}
  },
}

const postToolUseHook: HookCallback = {
  type: 'callback',
  internal: true,
  timeout: 200,
  async callback(input: HookInput): Promise<HookJSONOutput> {
    if (input.hook_event_name !== 'PostToolUse') return {}

    const { tool_name, tool_input } = input
    const external = isExternalTool(tool_name)

    logAuditEntry(
      buildAuditEntry({
        sessionId: getSessionIdSafe(),
        toolName: tool_name,
        toolInput: tool_input as Record<string, unknown>,
        external,
        phiBlocked: false,
        outcome: 'success',
      }),
    )

    return {}
  },
}

/**
 * Register compliance hooks for the session.
 * Called once from src/setup.ts when running as Verity Health Agent.
 * Hooks fire for all agents in the session — no per-agent registration needed.
 */
export function registerComplianceHooks(): void {
  registerHookCallbacks({
    PreToolUse: [{ hooks: [preToolUseHook] }],
    PostToolUse: [{ hooks: [postToolUseHook] }],
  })
}
