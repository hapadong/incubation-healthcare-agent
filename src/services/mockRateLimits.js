// HealthAgent stub: mock rate limits are never active in production
export const shouldProcessMockLimits = () => false
export const applyMockHeaders = (headers) => headers
export const checkMockFastModeRateLimit = () => null
export const getMockHeaderless429Message = () => null
export const getMockHeaders = () => ({})
export const isMockFastModeRateLimitScenario = () => false
export default {}
