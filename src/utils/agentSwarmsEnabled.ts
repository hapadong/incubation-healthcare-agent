import { isEnvTruthy } from './envUtils.js'

// Swarms are opt-in via HEALTHAGENT_ENABLE_SWARMS=true.
// Required for /team-review (TeamCreate tool). Off by default to avoid
// crashing on swarm infrastructure that was removed in Phase 0.
export const isAgentSwarmsEnabled = () => isEnvTruthy(process.env.HEALTHAGENT_ENABLE_SWARMS)
