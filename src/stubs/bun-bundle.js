// Stub for bun:bundle — feature() is compile-time in Bun; replaced by build script
const ENABLED_FEATURES = new Set(['AWAY_SUMMARY'])

export function feature(flag) {
  return ENABLED_FEATURES.has(flag)
}
