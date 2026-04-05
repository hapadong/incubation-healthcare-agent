import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { SelectMulti } from '../../components/CustomSelect/SelectMulti.js'
import TextInput from '../../components/TextInput.js'
import { Box, Text } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import { AgentTool } from '../../tools/AgentTool/AgentTool.js'
import { isBuiltInAgent } from '../../tools/AgentTool/loadAgentsDir.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js'
import { extractTextContent } from '../../utils/messages.js'

function toTitleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

/** Returns the first few non-empty lines of agent output as a readable preview. */
function snippet(text: string, maxLines = 3, maxLineLen = 100): string {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .slice(0, maxLines)
    .map(l => (l.length > maxLineLen ? l.slice(0, maxLineLen) + '…' : l))
    .join('\n')
}

type AgentStatus = 'pending' | 'running' | 'done' | 'error'

interface AgentResult {
  agentType: string
  status: AgentStatus
  text?: string
  error?: string
}

function TeamReviewSelector({
  onDone,
  initialQuestion,
  context,
}: {
  onDone: LocalJSXCommandOnDone
  initialQuestion: string
  context: ToolUseContext & LocalJSXCommandContext
}) {
  const agentDefinitions = useAppState(s => s.agentDefinitions)
  const [step, setStep] = useState<'question' | 'agents' | 'confirm' | 'dispatching'>(
    initialQuestion ? 'agents' : 'question',
  )
  const [question, setQuestion] = useState(initialQuestion)
  const [questionCursor, setQuestionCursor] = useState(initialQuestion.length)
  const [selectedAgents, setSelectedAgents] = useState<string[]>([])
  const [patientId, setPatientId] = useState('')
  const [patientIdCursor, setPatientIdCursor] = useState(0)
  const [agentResults, setAgentResults] = useState<AgentResult[]>([])
  const [agentSteps, setAgentSteps] = useState<Record<string, number>>({})
  const dispatchStarted = useRef(false)

  const clinicalAgents = agentDefinitions.allAgents.filter(a => !isBuiltInAgent(a))

  if (clinicalAgents.length === 0) {
    onDone(
      'No clinical agents found. Add agent .md files to .claude/agents/ and rebuild.',
      { display: 'system' },
    )
    return null
  }

  const options = clinicalAgents.map(agent => ({
    label: toTitleCase(agent.agentType),
    value: agent.agentType,
    description: (agent.whenToUse ?? '').split('.')[0],
  }))

  function handleQuestionSubmit(value: string) {
    const q = value.trim()
    if (!q) return
    setQuestion(q)
    setStep('agents')
  }

  function handleAgentsSubmit(selected: string[]) {
    if (selected.length === 0) {
      onDone('No agents selected. Team review cancelled.', { display: 'system' })
      return
    }
    setSelectedAgents(selected)
    setStep('confirm')
  }

  function handleCancel() {
    onDone('Team review cancelled.', { display: 'system' })
  }

  function handleConfirmSubmit(value: string) {
    const pid = value.trim()
    if (!pid) return
    setPatientId(pid)
    setAgentResults(selectedAgents.map(a => ({ agentType: a, status: 'pending' })))
    setStep('dispatching')
  }

  // Programmatic dispatch — runs once when step becomes 'dispatching'
  useEffect(() => {
    if (step !== 'dispatching' || dispatchStarted.current) return
    dispatchStarted.current = true

    const canUseTool =
      context.canUseTool ?? (() => Promise.resolve({ behavior: 'allow' as const }))

    async function runDispatch() {
      const results: AgentResult[] = selectedAgents.map(a => ({
        agentType: a,
        status: 'pending' as AgentStatus,
      }))

      const AGENT_TIMEOUT_MS = 3 * 60 * 1000 // 3 minutes per agent

      const agentPrompt = [
        `Clinical question: ${question}`,
        '',
        `Patient ID: ${patientId}`,
        '',
        `Please load this patient's record using the patient_load MCP tool (normalize bare numbers to mimic_<id>), then provide your specialty opinion on the clinical question above. Follow the output format in your instructions.`,
      ].join('\n')

      for (let i = 0; i < selectedAgents.length; i++) {
        const agentType = selectedAgents[i]!

        results[i] = { ...results[i]!, status: 'running' }
        setAgentResults([...results])

        // onProgress increments a step counter so the UI shows progress
        let step = 0
        const onProgress = (_data: unknown) => {
          step++
          setAgentSteps(prev => ({ ...prev, [agentType]: step }))
        }

        try {
          const agentCall = (AgentTool as any).call(
            { prompt: agentPrompt, subagent_type: agentType },
            context,
            canUseTool,
            { message: { id: `mdt-${agentType}` } } as any,
            onProgress,
          )
          const timeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Agent timed out after 3 minutes')), AGENT_TIMEOUT_MS),
          )
          const result = await Promise.race([agentCall, timeout])
          const data = result.data as any
          const text = data?.content
            ? extractTextContent(data.content, '\n')
            : String(data)
          results[i] = { agentType, status: 'done', text }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err)
          results[i] = {
            agentType,
            status: 'error',
            error: errMsg,
          }
        }

        setAgentResults([...results])
      }

      // Build synthesis prompt with agent outputs as meta context
      const doneResults = results.filter(r => r.status === 'done')
      const errorResults = results.filter(r => r.status === 'error')

      const metaMessages: string[] = doneResults.map(
        r => `=== ${toTitleCase(r.agentType)} Opinion ===\n${r.text ?? ''}`,
      )

      if (errorResults.length > 0) {
        metaMessages.push(
          `=== Failed Agents ===\n${errorResults
            .map(r => `${toTitleCase(r.agentType)}: ${r.error ?? 'unknown error'}`)
            .join('\n')}`,
        )
      }

      if (doneResults.length === 0) {
        const errorSummary = errorResults
          .map(r => `• ${toTitleCase(r.agentType)}: ${r.error ?? 'unknown error'}`)
          .join('\n')
        onDone(
          `All agents failed. Team review could not be completed.\n\nErrors:\n${errorSummary}`,
          { display: 'system' },
        )
        return
      }

      const agentSummary = doneResults.map(r => toTitleCase(r.agentType)).join(', ')

      const synthesisPrompt = [
        `You have received specialist opinions from the following MDT members for patient ${patientId}: ${agentSummary}.`,
        `The clinical question was: ${question}`,
        '',
        'Their individual assessments are provided as context above. Now synthesize them into a unified MDT recommendation:',
        '• Points of consensus across specialties',
        '• Conflicting views that need team discussion',
        '• Immediate actions (within 24–48 hours)',
        '• Short-term plan (within 1–2 weeks)',
        '• Top 3 most actionable next steps',
      ].join('\n')

      onDone(synthesisPrompt, {
        display: 'user',
        shouldQuery: true,
        metaMessages,
      })
    }

    runDispatch()
  }, [step]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Question step ──────────────────────────────────────────────────────────
  if (step === 'question') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Team Review — Step 1 of 3</Text>
        <Text>What clinical question should the team address?</Text>
        <Text dimColor>
          Enter to continue · Esc to cancel · or use /team-review &lt;question&gt;
        </Text>
        <TextInput
          value={question}
          onChange={setQuestion}
          onSubmit={handleQuestionSubmit}
          cursorOffset={questionCursor}
          onChangeCursorOffset={setQuestionCursor}
          isDisabled={false}
          multiline={false}
          focus={true}
        />
      </Box>
    )
  }

  // ── Agent selection step ───────────────────────────────────────────────────
  if (step === 'agents') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{initialQuestion ? 'Team Review — Step 1 of 2' : 'Team Review — Step 2 of 3'}</Text>
        <Text dimColor>
          Question: <Text color="cyan">{question}</Text>
        </Text>
        <Text>Select specialists to consult:</Text>
        <Text dimColor>↑↓ navigate · Space to toggle · Tab to jump to submit · Esc to cancel</Text>
        <SelectMulti
          options={options}
          onSubmit={handleAgentsSubmit}
          onCancel={handleCancel}
          submitButtonText="Select specialists"
        />
      </Box>
    )
  }

  // ── Confirmation step ──────────────────────────────────────────────────────
  if (step === 'confirm') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{initialQuestion ? 'Team Review — Step 2 of 2' : 'Team Review — Step 3 of 3'}: Confirm</Text>
        <Text dimColor>
          Question: <Text color="cyan">{question}</Text>
        </Text>
        <Text dimColor>
          Specialists:{' '}
          <Text color="cyan">{selectedAgents.map(toTitleCase).join(', ')}</Text>
        </Text>
        <Text>Enter patient ID to start the review:</Text>
        <Text dimColor>e.g. mimic_10000032 — Enter to dispatch · Esc to cancel</Text>
        <TextInput
          value={patientId}
          onChange={setPatientId}
          onSubmit={handleConfirmSubmit}
          cursorOffset={patientIdCursor}
          onChangeCursorOffset={setPatientIdCursor}
          isDisabled={false}
          multiline={false}
          focus={true}
        />
      </Box>
    )
  }

  // ── Dispatching step ───────────────────────────────────────────────────────
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Team Review — Running</Text>
      <Text dimColor>
        Question: <Text color="cyan">{question}</Text>
      </Text>
      <Text dimColor>
        Patient: <Text color="cyan">{patientId}</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {agentResults.map(r => {
          const icon =
            r.status === 'pending'
              ? '○'
              : r.status === 'running'
                ? '●'
                : r.status === 'done'
                  ? '✓'
                  : '✗'
          const color =
            r.status === 'pending'
              ? 'gray'
              : r.status === 'running'
                ? 'yellow'
                : r.status === 'done'
                  ? 'green'
                  : 'red'
          const steps = agentSteps[r.agentType] ?? 0
          return (
            <Box key={r.agentType} flexDirection="column" marginBottom={r.status === 'done' ? 1 : 0}>
              <Text>
                <Text color={color}>{icon} </Text>
                <Text bold={r.status !== 'pending'}>{toTitleCase(r.agentType)}</Text>
                {r.status === 'running' && (
                  <Text dimColor>
                    {steps > 0 ? ` — step ${steps}…` : ' — thinking…'}
                  </Text>
                )}
                {r.status === 'error' && (
                  <Text color="red"> — {r.error ?? 'error'}</Text>
                )}
              </Text>
              {r.status === 'done' && r.text && (
                <Box flexDirection="column" paddingLeft={2}>
                  {snippet(r.text).split('\n').map((line, idx) => (
                    <Text key={idx} dimColor>{line}</Text>
                  ))}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  return (
    <TeamReviewSelector
      onDone={onDone}
      initialQuestion={args.trim()}
      context={context}
    />
  )
}
