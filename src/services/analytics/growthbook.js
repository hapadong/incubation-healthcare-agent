// HealthAgent stub: GrowthBook feature flags — always return defaults
export const getFeatureValue_CACHED_MAY_BE_STALE = (_flagName, defaultValue) => defaultValue
export const getDynamicConfig_CACHED_MAY_BE_STALE = (_configName, defaultValue) => defaultValue
export const initializeGrowthBook = async () => {}
export const resetGrowthBook = () => {}
export const getGrowthBookInstance = () => null
export const isGrowthBookInitialized = () => false
export const getExperimentValue = (_name, defaultValue) => defaultValue
export default {}
