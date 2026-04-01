/**
 * Stub: channel notification support removed.
 * All exports are no-ops to satisfy imports from print.ts,
 * useManageMCPConnections.ts, and interactiveHandler.ts.
 */

export const CHANNEL_PERMISSION_METHOD = 'notifications/channel_permission'
export const CHANNEL_PERMISSION_REQUEST_METHOD = 'notifications/channel_permission_request'

export type ChannelPermissionRequestParams = Record<string, unknown>

export function ChannelMessageNotificationSchema(): { method: string } {
  return { method: 'notifications/channel_message' }
}

export function ChannelPermissionNotificationSchema(): { method: string } {
  return { method: CHANNEL_PERMISSION_METHOD }
}

export function findChannelEntry(
  _serverName: string,
  _channels: unknown[],
): null {
  return null
}

export function gateChannelServer(
  _serverName: string,
  _capabilities: unknown,
  _pluginSource?: unknown,
): { action: 'skip' } {
  return { action: 'skip' }
}

export function wrapChannelMessage(
  _serverName: string,
  _content: unknown,
  _meta: unknown,
): string {
  return ''
}

export function getEffectiveChannelAllowlist(
  _subscriptionType: unknown,
  _allowedChannelPlugins: unknown,
): { entries: Array<{ plugin: string; marketplace: string }>; source: 'ledger' | 'org' } {
  return { entries: [], source: 'ledger' }
}
