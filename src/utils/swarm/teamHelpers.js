// HealthAgent stub: team file helpers (tmux/iTerm2 backends removed in Phase 0).
// No-op implementations — HealthAgent runs as standalone leader, never in a team file context.

export const readTeamFile = (_teamName) => null

export const readTeamFileAsync = async (_teamName) => null

export const setMemberActive = async (_teamName, _agentName, _active) => {}

export const setMemberMode = async (_teamName, _agentName, _mode) => {}

export const setMultipleMemberModes = async (_teamName, _modes) => {}

export const syncTeammateMode = async (_teamName, _agentName) => {}

export const removeTeammateFromTeamFile = async (_teamName, _agentName) => {}

export const removeMemberFromTeam = async (_teamName, _agentName) => {}

export const addHiddenPaneId = (_teamName, _paneId) => {}

export const removeHiddenPaneId = (_teamName, _paneId) => {}

export const writeTeamFile = (_teamName, _data) => {}

export const writeTeamFileAsync = async (_teamName, _data) => {}

export default {}
