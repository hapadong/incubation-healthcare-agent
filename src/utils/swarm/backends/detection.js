// HealthAgent stub: swarm/tmux detection — not used
export const isInsideTmux = async () => false
export const isInsideTmuxSync = () => false
export const IT2_COMMAND = 'it2'
export const getBackendByType = () => ({
  killPane: async () => {},
  selectPane: async () => {},
})
export const getSwarmSocketName = () => 'healthagent-swarm'
export default {}
