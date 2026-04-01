// HealthAgent: OAuth constants stub
export const getOauthConfig = () => ({
  BASE_API_URL: process.env.HEALTHAGENT_API_BASE_URL ?? 'http://localhost:11434/v1',
  CLIENT_ID: '',
  TOKEN_URL: '',
  CONSOLE_AUTHORIZE_URL: '',
  CLAUDE_AI_AUTHORIZE_URL: '',
  API_KEY_URL: '',
  ROLES_URL: '',
  MANUAL_REDIRECT_URL: '',
})
