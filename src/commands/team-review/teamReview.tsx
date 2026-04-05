import * as React from 'react'
import { SelectMulti } from '../../components/CustomSelect/SelectMulti.js'
import { Box, Text } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import { isBuiltInAgent } from '../../tools/AgentTool/loadAgentsDir.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js'

function toTitleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function TeamReviewSelector({ onDone }: { onDone: LocalJSXCommandOnDone }) {
  const agentDefinitions = useAppState(s => s.agentDefinitions)

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

  function handleSubmit(selected: string[]) {
    if (selected.length === 0) {
      onDone('No agents selected. Team review cancelled.', { display: 'system' })
      return
    }

    const agentList = selected.join(', ')
    const prompt = [
      `Run a multidisciplinary team review with the following clinical specialists: ${agentList}.`,
      '',
      'Steps:',
      '1. Identify the current patient — use the most recently discussed patient, or ask if unclear.',
      '2. Load the patient record using the patient MCP tools.',
      `3. Use TeamCreate to dispatch these agents in parallel: ${agentList}`,
      '   Each agent should independently assess the patient from their specialty perspective.',
      '   Provide each agent with the patient summary as context.',
      '4. Wait for all agents to complete their assessments.',
      '5. Synthesize into a unified multidisciplinary recommendation:',
      '   • Immediate actions (within 24-48 hours)',
      '   • Short-term actions (within 1-2 weeks)',
      '   • Points of consensus across specialties',
      '   • Conflicting recommendations requiring team discussion',
      '   • Top 3 most actionable next steps',
    ].join('\n')

    onDone(prompt, { display: 'user', shouldQuery: true })
  }

  function handleCancel() {
    onDone('Team review cancelled.', { display: 'system' })
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Select clinical specialists for team review:</Text>
      <Text dimColor>Space to toggle · Enter to confirm · Esc to cancel</Text>
      <SelectMulti
        options={options}
        onSubmit={handleSubmit}
        onCancel={handleCancel}
        submitButtonText="Start team review"
      />
    </Box>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: ToolUseContext & LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return <TeamReviewSelector onDone={onDone} />
}
