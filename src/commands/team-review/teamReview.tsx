import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { SelectMulti } from '../../components/CustomSelect/SelectMulti.js'
import TextInput from '../../components/TextInput.js'
import { Box, Text, useInput } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import { findToolByName, type ToolUseContext } from '../../Tool.js'
import { AgentTool } from '../../tools/AgentTool/AgentTool.js'
import { isBuiltInAgent } from '../../tools/AgentTool/loadAgentsDir.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js'
import { extractTextContent } from '../../utils/messages.js'

function toTitleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

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
type PatientSource = 'local' | 'mimic'

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
  const mcpTools = useAppState(s => s.mcp.tools)
  const mcpToolsRef = useRef(mcpTools)
  useEffect(() => { mcpToolsRef.current = mcpTools }, [mcpTools])

  const [step, setStep] = useState<'question' | 'agents' | 'confirm' | 'loading' | 'confirm_dispatch' | 'not_found' | 'running'>(
    initialQuestion ? 'agents' : 'question',
  )
  const [question, setQuestion] = useState(initialQuestion)
  const [questionCursor, setQuestionCursor] = useState(initialQuestion.length)
  const [selectedAgents, setSelectedAgents] = useState<string[]>([])
  const [patientId, setPatientId] = useState('')
  const [loadLog, setLoadLog] = useState<string[]>([])
  const [patientSummary, setPatientSummary] = useState('')
  const [patientSource, setPatientSource] = useState<PatientSource | null>(null)
  const [agentResults, setAgentResults] = useState<AgentResult[]>([])
  const [agentSteps, setAgentSteps] = useState<Record<string, number>>({})
  const loadStarted = useRef(false)
  const dispatchStarted = useRef(false)

  const clinicalAgents = agentDefinitions.allAgents.filter(a => !isBuiltInAgent(a))

  if (clinicalAgents.length === 0) {
    onDone('No clinical agents found. Add agent .md files to .claude/agents/ and rebuild.', { display: 'system' })
    return null
  }

  const options = clinicalAgents.map(agent => ({
    label: toTitleCase(agent.agentType),
    value: agent.agentType,
    description: (agent.whenToUse ?? '').split('.')[0],
  }))

  function handleCancel() {
    onDone('Team review cancelled.', { display: 'system' })
  }

  function handleAgentsSubmit(selected: string[]) {
    if (selected.length === 0) { handleCancel(); return }
    setSelectedAgents(selected)
    setStep('confirm')
  }

  useInput(
    (input, key) => {
      if (step === 'confirm') {
        if (key.escape) { handleCancel(); return }
        if (key.return) {
          if (patientId.trim()) setStep('loading')
          return
        }
        if (key.backspace || key.delete) { setPatientId(prev => prev.slice(0, -1)); return }
        if (input && !key.ctrl && !key.meta) { setPatientId(prev => prev + input) }
        return
      }
      if (step === 'confirm_dispatch') {
        if (key.escape) { handleCancel(); return }
        if (key.return) { setStep('running'); return }
      }
      if (step === 'not_found') {
        if (key.escape || key.return) { handleCancel(); return }
      }
    },
    { isActive: step === 'confirm' || step === 'confirm_dispatch' || step === 'not_found' },
  )

  // ── Load patient once ──────────────────────────────────────────────────────
  useEffect(() => {
    if (step !== 'loading' || loadStarted.current) return
    loadStarted.current = true

    const pid = patientId.trim()
    const canUseTool = context.canUseTool ?? (() => Promise.resolve({ behavior: 'allow' as const }))
    const log = (line: string) => setLoadLog(prev => [...prev, line])

    async function callMcpTool(name: string, args: Record<string, unknown>): Promise<string> {
      const tool = findToolByName(mcpToolsRef.current, name)
      if (!tool) return ''
      const result = await tool.call(args as any, context, canUseTool, { message: { content: [] } } as any)
      const data = result.data as any
      return Array.isArray(data) ? extractTextContent(data, '\n') : String(data ?? '')
    }

    async function runLoad() {
      try {
        // Step 1: check local patient store
        log(`[1/2] Checking local patient store for "${pid}"…`)
        log(`      → Calling mcp__patients__patient_load (approval may be required)`)
        const localText = await callMcpTool('mcp__patients__patient_load', { id: pid })
        const lowerLocal = localText.toLowerCase()
        const foundLocally = localText.length > 0 &&
          !lowerLocal.includes('not found') &&
          !lowerLocal.includes('no patient') &&
          !lowerLocal.includes('available patients') &&
          !lowerLocal.includes('available ids')

        if (foundLocally) {
          log(`      ✓ Patient found in local store.`)
          setPatientSummary(localText)
          setPatientSource('local')
          setAgentResults(selectedAgents.map(a => ({ agentType: a, status: 'pending' })))
          setStep('confirm_dispatch')
          return
        }

        log(`      ✗ Not found in local store.`)

        // Step 2: query MIMIC database
        log(`[2/2] Querying MIMIC database for subject_id "${pid}"…`)
        log(`      → Calling mcp__mimic__mimic_patient (approval may be required)`)
        const numericId = Number(pid)
        const mimicText = await callMcpTool('mcp__mimic__mimic_patient', { subject_id: numericId || pid })
        const lowerMimic = mimicText.toLowerCase()
        const foundInMimic = mimicText.length > 50 &&
          !lowerMimic.includes('not found') &&
          !lowerMimic.includes('no patient') &&
          !lowerMimic.includes('no records') &&
          !lowerMimic.includes('no rows') &&
          !lowerMimic.includes('0 rows') &&
          !lowerMimic.includes('does not exist') &&
          !lowerMimic.includes('error')
        if (foundInMimic) {
          log(`      ✓ Patient loaded from MIMIC.`)
          setPatientSummary(mimicText)
          setPatientSource('mimic')
          setAgentResults(selectedAgents.map(a => ({ agentType: a, status: 'pending' })))
          setStep('confirm_dispatch')
          return
        }

        log(`      ✗ Patient not found in MIMIC.`)
        log(``)
        log(`No patient record found. Stopping.`)
        setStep('not_found')
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        log(`      ✗ Error: ${msg}`)
        setStep('not_found')
      }
    }

    runLoad()
  }, [step]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Dispatch agents ────────────────────────────────────────────────────────
  useEffect(() => {
    if (step !== 'running' || dispatchStarted.current) return
    dispatchStarted.current = true

    const pid = patientId.trim()
    const canUseTool = context.canUseTool ?? (() => Promise.resolve({ behavior: 'allow' as const }))

    // Patient data injected once — agents have disallowedTools for patient_load/mimic_patient
    const agentPrompt = [
      `You are participating in a multidisciplinary team (MDT) review.`,
      ``,
      `Clinical question: ${question}`,
      `Patient ID: ${pid}`,
      ``,
      `## Patient Record`,
      patientSummary,
      ``,
      `Based on the patient record above, provide your specialty opinion on the clinical question.`,
      `Follow the output format in your agent instructions.`,
    ].join('\n')

    const results: AgentResult[] = selectedAgents.map(a => ({ agentType: a, status: 'pending' as AgentStatus }))
    setAgentResults([...results])

    async function runDispatch() {
      const AGENT_TIMEOUT_MS = 3 * 60 * 1000

      for (let i = 0; i < selectedAgents.length; i++) {
        const agentType = selectedAgents[i]!
        results[i] = { ...results[i]!, status: 'running' }
        setAgentResults([...results])

        let stepCount = 0
        const onProgress = (_data: unknown) => {
          stepCount++
          setAgentSteps(prev => ({ ...prev, [agentType]: stepCount }))
        }

        try {
          const result = await Promise.race([
            (AgentTool as any).call(
              { prompt: agentPrompt, subagent_type: agentType },
              context,
              canUseTool,
              { message: { content: [] } } as any,
              onProgress,
            ),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Agent timed out after 3 minutes')), AGENT_TIMEOUT_MS),
            ),
          ])
          const data = result.data as any
          const text = data?.content ? extractTextContent(data.content, '\n') : String(data ?? '')
          results[i] = { agentType, status: 'done', text }
        } catch (err: unknown) {
          results[i] = { agentType, status: 'error', error: err instanceof Error ? err.message : String(err) }
        }

        setAgentResults([...results])
      }

      const doneResults = results.filter(r => r.status === 'done')
      const errorResults = results.filter(r => r.status === 'error')

      if (doneResults.length === 0) {
        onDone(
          `All agents failed.\n\n${errorResults.map(r => `• ${toTitleCase(r.agentType)}: ${r.error ?? 'unknown'}`).join('\n')}`,
          { display: 'system' },
        )
        return
      }

      const metaMessages = [
        `=== Patient Record: ${pid} ===\n${patientSummary}`,
        ...doneResults.map(r => `=== ${toTitleCase(r.agentType)} Opinion ===\n${r.text ?? ''}`),
        ...(errorResults.length > 0
          ? [`=== Failed Agents ===\n${errorResults.map(r => `${toTitleCase(r.agentType)}: ${r.error}`).join('\n')}`]
          : []),
      ]

      onDone(
        [
          `Specialist opinions from the MDT review for patient ${pid} are provided above.`,
          `Clinical question: ${question}`,
          `Specialists: ${doneResults.map(r => toTitleCase(r.agentType)).join(', ')}`,
          ``,
          `Synthesize into a unified MDT recommendation:`,
          `• Points of consensus across specialties`,
          `• Conflicting views that need team discussion`,
          `• Immediate actions (within 24–48 hours)`,
          `• Short-term plan (within 1–2 weeks)`,
          `• Top 3 most actionable next steps`,
        ].join('\n'),
        { display: 'user', shouldQuery: true, metaMessages },
      )
    }

    runDispatch()
  }, [step]) // eslint-disable-line react-hooks/exhaustive-deps

  if (step === 'question') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Team Review — Step 1 of 3</Text>
        <Text>What clinical question should the team address?</Text>
        <Text dimColor>Enter to continue · Esc to cancel</Text>
        <TextInput
          value={question}
          onChange={setQuestion}
          onSubmit={() => { if (question.trim()) setStep('agents') }}
          cursorOffset={questionCursor}
          onChangeCursorOffset={setQuestionCursor}
          isDisabled={false}
          multiline={false}
          focus={true}
        />
      </Box>
    )
  }

  if (step === 'agents') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{initialQuestion ? 'Team Review — Step 1 of 2' : 'Team Review — Step 2 of 3'}</Text>
        <Text dimColor>Question: <Text color="cyan">{question}</Text></Text>
        <Text>Select specialists to consult:</Text>
        <Text dimColor>↑↓ navigate · Space to toggle · Tab to submit · Esc to cancel</Text>
        <SelectMulti
          options={options}
          onSubmit={handleAgentsSubmit}
          onCancel={handleCancel}
          submitButtonText="Select specialists"
        />
      </Box>
    )
  }

  if (step === 'confirm') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{initialQuestion ? 'Team Review — Step 2 of 2' : 'Team Review — Step 3 of 3'}: Confirm</Text>
        <Text dimColor>Question: <Text color="cyan">{question}</Text></Text>
        <Text dimColor>Specialists: <Text color="cyan">{selectedAgents.map(toTitleCase).join(', ')}</Text></Text>
        <Text>Enter patient ID to start the review:</Text>
        <Text dimColor>e.g. 12352097 or manual_20260405_001 — Enter to start · Esc to cancel</Text>
        <Text>{patientId}<Text inverse> </Text></Text>
      </Box>
    )
  }

  if (step === 'loading') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Team Review — Loading Patient</Text>
        <Text dimColor>Patient ID: <Text color="cyan">{patientId}</Text></Text>
        {loadLog.map((line, i) => (
          <Text key={i} color={line.startsWith('      ✓') ? 'green' : line.startsWith('      ✗') ? 'red' : 'gray'}>
            {line}
          </Text>
        ))}
      </Box>
    )
  }

  if (step === 'confirm_dispatch') {
    const sourceLabel = patientSource === 'mimic' ? 'MIMIC database' : 'local store'
    const summarySnippet = snippet(patientSummary, 5, 120)
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Team Review — Patient Found</Text>
        <Text color="green">✓ Patient "{patientId}" loaded from {sourceLabel}.</Text>
        {loadLog.map((line, i) => (
          <Text key={i} color={line.startsWith('      ✓') ? 'green' : line.startsWith('      ✗') ? 'red' : 'gray'}>
            {line}
          </Text>
        ))}
        <Box flexDirection="column" marginTop={1} paddingLeft={2} borderStyle="single" borderColor="cyan">
          {summarySnippet.split('\n').map((line, i) => <Text key={i} dimColor>{line}</Text>)}
          {patientSummary.split('\n').length > 5 && <Text dimColor>…</Text>}
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Specialists: <Text color="cyan">{selectedAgents.map(toTitleCase).join(', ')}</Text></Text>
          <Text dimColor>Question: <Text color="cyan">{question}</Text></Text>
        </Box>
        <Text>Press <Text bold>Enter</Text> to dispatch {selectedAgents.length} specialist agent{selectedAgents.length > 1 ? 's' : ''} · <Text bold>Esc</Text> to cancel</Text>
      </Box>
    )
  }

  if (step === 'not_found') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Team Review — Patient Not Found</Text>
        {loadLog.map((line, i) => (
          <Text key={i} color={line.startsWith('      ✓') ? 'green' : line.startsWith('      ✗') ? 'red' : 'gray'}>
            {line}
          </Text>
        ))}
        <Box marginTop={1} flexDirection="column">
          <Text color="red">No patient record found for "{patientId}". Review stopped.</Text>
          <Text dimColor>• For MIMIC patients: ensure database auth is active</Text>
          <Text dimColor>• To create a new patient: run /patient new {'<'}clinical notes{'>'}</Text>
        </Box>
        <Text dimColor>Press <Text bold>Enter</Text> or <Text bold>Esc</Text> to exit</Text>
      </Box>
    )
  }

  // Running step
  const sourceLabel = patientSource === 'mimic' ? 'MIMIC' : 'local'
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Team Review — Running MDT Consultation</Text>
      <Text dimColor>Question: <Text color="cyan">{question}</Text></Text>
      <Text dimColor>Patient: <Text color="cyan">{patientId}</Text> <Text color="gray">({sourceLabel})</Text></Text>
      <Box flexDirection="column" marginTop={1}>
        {agentResults.map(r => {
          const icon = r.status === 'pending' ? '○' : r.status === 'running' ? '●' : r.status === 'done' ? '✓' : '✗'
          const color = r.status === 'pending' ? 'gray' : r.status === 'running' ? 'yellow' : r.status === 'done' ? 'green' : 'red'
          const steps = agentSteps[r.agentType] ?? 0
          return (
            <Box key={r.agentType} flexDirection="column" marginBottom={r.status === 'done' ? 1 : 0}>
              <Text>
                <Text color={color}>{icon} </Text>
                <Text bold={r.status !== 'pending'}>{toTitleCase(r.agentType)}</Text>
                {r.status === 'running' && (
                  <Text dimColor>{steps > 0 ? ` — step ${steps}…` : ' — thinking…'}</Text>
                )}
                {r.status === 'error' && <Text color="red"> — {r.error ?? 'error'}</Text>}
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
