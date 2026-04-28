import uniqBy from 'lodash-es/uniqBy.js'
import type { Command } from '../commands.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import { initBuiltinPlugins } from '../plugins/bundled/index.js'
import { getMcpToolsCommandsAndResources } from '../services/mcp/client.js'
import { getClaudeCodeMcpConfigs } from '../services/mcp/config.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import { initBundledSkills } from '../skills/bundled/index.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import type { AppState } from '../state/AppStateStore.js'
import { onChangeAppState } from '../state/onChangeAppState.js'
import { createStore } from '../state/store.js'
import type { Tools } from '../Tool.js'
import { assembleToolPool } from '../tools.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { getAgentDefinitionsWithOverrides } from '../tools/AgentTool/loadAgentsDir.js'
import type { PermissionMode } from '../types/permissions.js'
import { hasPermissionsToUseTool } from '../utils/permissions/permissions.js'
import { initializeToolPermissionContext } from '../utils/permissions/permissionSetup.js'
import { getCommands } from '../commands.js'

export type WebPermissionRequest = {
  toolName: string
  toolDescription: string
  input: Record<string, unknown>
  message: string
}

export type WebPermissionDecision = 'allow' | 'allow_always' | 'deny'

export type EngineSession = {
  tools: Tools
  commands: Command[]
  mcpClients: MCPServerConnection[]
  // Maps server name → list of tool names that server provides
  mcpServerToolNames: Map<string, string[]>
  agents: AgentDefinition[]
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
}

export type McpServerMeta = {
  name: string
  status: 'connected' | 'error' | 'disabled'
  tools: string[]
}

let initialized = false

// Must run once before getCommands() reads bundled skills/plugins
function ensureInitialized(): void {
  if (initialized) return
  initialized = true
  initBuiltinPlugins()
  initBundledSkills()
}

export async function createEngineSession(opts: {
  cwd: string
  permissionMode?: PermissionMode
}): Promise<EngineSession> {
  const { cwd, permissionMode = 'default' } = opts

  ensureInitialized()

  const [mcpConfigResult, commandsResult, agentDefsResult, permCtxResult] =
    await Promise.all([
      getClaudeCodeMcpConfigs(),
      getCommands(cwd),
      getAgentDefinitionsWithOverrides(cwd),
      initializeToolPermissionContext({
        allowedToolsCli: [],
        disallowedToolsCli: [],
        permissionMode,
        allowDangerouslySkipPermissions: false,
        addDirs: [],
      }),
    ])

  const { toolPermissionContext } = permCtxResult

  const mcpClients: MCPServerConnection[] = []
  const mcpTools: Tools = []
  const mcpCommands: Command[] = []
  const mcpServerToolNames = new Map<string, string[]>()

  await getMcpToolsCommandsAndResources(({ client, tools, commands }) => {
    mcpClients.push(client)
    mcpTools.push(...tools)
    mcpCommands.push(...(commands as Command[]))
    mcpServerToolNames.set(client.name, tools.map(t => t.name))
  }, mcpConfigResult.servers)

  // assembleToolPool calls getTools() internally and merges with MCP tools,
  // deduplicating by name (built-ins win) and sorting for prompt-cache stability
  const allTools = assembleToolPool(toolPermissionContext, mcpTools)

  const defaultState = getDefaultAppState()
  const initialState: AppState = {
    ...defaultState,
    mcp: {
      ...defaultState.mcp,
      clients: mcpClients,
      commands: uniqBy(
        [...defaultState.mcp.commands, ...mcpCommands],
        'name',
      ),
      tools: uniqBy([...defaultState.mcp.tools, ...mcpTools], 'name'),
    },
    toolPermissionContext,
  }

  const store = createStore(initialState, onChangeAppState)

  return {
    tools: allTools,
    commands: uniqBy([...commandsResult, ...(mcpCommands as Command[])], 'name'),
    mcpClients,
    mcpServerToolNames,
    agents: agentDefsResult.activeAgents,
    getAppState: () => store.getState(),
    setAppState: store.setState,
  }
}

// Returns metadata about MCP servers for the web UI sidebar.
// Call after createEngineSession so clients are already connected.
export function getMcpServerMeta(session: EngineSession): McpServerMeta[] {
  return session.mcpClients.map(client => ({
    name: client.name,
    status: client.type === 'connected' ? 'connected'
      : client.type === 'failed' ? 'error'
      : 'disabled',
    tools: session.mcpServerToolNames.get(client.name) ?? [],
  }))
}

// Creates a CanUseToolFn for the web path.
// requestPermission is called when rules don't auto-approve or deny — the web
// server pauses the SSE stream and shows the user a permission modal.
export function createWebCanUseTool(
  requestPermission: (req: WebPermissionRequest) => Promise<WebPermissionDecision>,
  onAllowAlways: (toolName: string) => void,
): CanUseToolFn {
  return async (tool, input, toolUseContext, assistantMessage, toolUseID, forceDecision) => {
    if (forceDecision !== undefined) return forceDecision

    const decision = await hasPermissionsToUseTool(
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseID,
    )

    if (decision.behavior !== 'ask') return decision

    const webDecision = await requestPermission({
      toolName: tool.name,
      toolDescription: (tool as { description?: string }).description ?? '',
      input: input as Record<string, unknown>,
      message: decision.message,
    })

    if (webDecision === 'deny') {
      return {
        behavior: 'deny',
        message: `User denied permission for ${tool.name}`,
        decisionReason: { type: 'manual', reason: 'web_denied' } as never,
      }
    }

    if (webDecision === 'allow_always') {
      // Notify server layer so it can add an alwaysAllow rule to the session
      // app state, making future calls to this tool auto-approved without prompting
      onAllowAlways(tool.name)
    }

    return { behavior: 'allow' }
  }
}
