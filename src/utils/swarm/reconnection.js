// Stub — reconnection logic removed in Phase 0 (tmux/iTerm2 backends deleted).
// HealthAgent sessions are never spawned as in-process teammates,
// so these paths are never reached at runtime.
export function initializeTeammateContextFromSession(_setAppState, _teamName, _agentName) {
  // no-op
}

export function computeInitialTeamContext() {
  return undefined
}
