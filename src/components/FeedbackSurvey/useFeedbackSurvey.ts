// HealthAgent stub: feedback surveys disabled
const closedSurvey = {
  state: 'closed' as const,
  lastResponse: null,
  handleSelect: () => false,
  handleTranscriptSelect: () => {},
}

export function useFeedbackSurvey(
  _messages: unknown,
  _isLoading: unknown,
  _submitCount: unknown,
  _type: unknown,
  _hasActivePrompt: unknown,
) {
  return closedSurvey
}
