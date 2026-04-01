// HealthAgent: Analytics stub — all telemetry removed
// Call sites preserved for compatibility; all functions are no-ops

export const logEvent = (..._args: unknown[]) => {}
export const logAnalyticsEvent = (..._args: unknown[]) => {}
export const trackEvent = (..._args: unknown[]) => {}
export const initAnalytics = (..._args: unknown[]) => {}
export const flushAnalytics = async (..._args: unknown[]) => {}
export const setAnalyticsUser = (..._args: unknown[]) => {}
export const recordUsage = (..._args: unknown[]) => {}
export default { logEvent, logAnalyticsEvent, trackEvent, initAnalytics, flushAnalytics }
