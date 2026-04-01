// HealthAgent stub: post-compact survey disabled
export function usePostCompactSurvey(
  _messages: unknown,
  _isLoading: unknown,
  _hasActivePrompt: unknown,
  _opts?: unknown,
) {
  return {
    state: 'closed' as const,
    lastResponse: null,
    handleSelect: () => {},
  }
}
