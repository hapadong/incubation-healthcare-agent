import { isHealthAgentMode } from './envUtils.js'

// Swarms are enabled for all HealthAgent sessions (supports /team-review).
// In non-HealthAgent (standard Claude Code) mode, swarms remain disabled.
export const isAgentSwarmsEnabled = () => isHealthAgentMode()
