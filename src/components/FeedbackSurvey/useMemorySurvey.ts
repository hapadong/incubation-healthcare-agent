// HealthAgent stub: memory survey disabled
export function useMemorySurvey(
  _messages: unknown,
  _isLoading: unknown,
  _hasActivePrompt: unknown,
  _opts?: unknown,
) {
  return {
    state: 'closed' as const,
    lastResponse: null,
    handleSelect: () => {},
    handleTranscriptSelect: () => {},
  }
}
