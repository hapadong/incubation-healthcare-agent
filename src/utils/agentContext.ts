export const getAgentContext = () => ({})
export const setAgentContext = (..._a: unknown[]) => {}
export function runWithAgentContext<T>(_context: unknown, fn: () => T): T {
  return fn()
}
