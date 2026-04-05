// Stub — leader/worker permission bridge removed in Phase 0 (tmux/iTerm2 backends deleted).
// HealthAgent runs as a standalone leader, never as a tmux worker,
// so these cross-process permission bridges are never needed at runtime.
export function registerLeaderToolUseConfirmQueue(_queue) {
  // no-op
}

export function unregisterLeaderToolUseConfirmQueue() {
  // no-op
}

export function registerLeaderSetToolPermissionContext(_setter) {
  // no-op
}

export function unregisterLeaderSetToolPermissionContext() {
  // no-op
}

export function getLeaderToolUseConfirmQueue() {
  return null
}
