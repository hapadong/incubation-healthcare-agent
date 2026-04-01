// HealthAgent: OAuth stub — Claude.ai OAuth removed
// All auth flows replaced by HEALTHAGENT_API_KEY env var

export const startOAuthFlow = async () => { throw new Error('OAuth not supported') }
export const refreshOAuthToken = async () => null
export const getOAuthTokens = async () => null
export class OAuthService {
  startOAuthFlow = startOAuthFlow
  refreshOAuthToken = refreshOAuthToken
}
