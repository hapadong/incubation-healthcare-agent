// HealthAgent stub: pane backend registry (tmux/iTerm2 removed in Phase 0).
// All functions return safe no-op values. In-process teammate mode is the
// only active backend; pane-based backends are never available.

export const isInProcessEnabled = () => false

export const getCachedDetectionResult = () => null

export const getCachedBackend = () => null

export const getBackendByType = (_type) => null

export const ensureBackendsRegistered = async () => {}

export const getResolvedTeammateMode = () => 'in-process'

export default {}
