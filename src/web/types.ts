export type ChatMsg = {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolName?: string
  input?: Record<string, unknown>
  streaming?: boolean
}

export type StoredSession = {
  id: string
  title: string
  createdAt: string   // ISO
  updatedAt: string   // ISO
  messages: ChatMsg[]
}

export type ControlRequest = {
  requestId: string
  toolName: string
  toolDescription: string
  input: Record<string, unknown>
  message: string
}

export type McpServerMeta = {
  name: string
  status: 'connected' | 'error' | 'disabled'
  tools: string[]
}

export type CommandMeta = {
  name: string
  description: string
  isSkill: boolean
}

export type McpToolMeta = {
  name: string
  server: string
  description: string
}

export type MetaResponse = {
  commands: CommandMeta[]
  mcpServers: McpServerMeta[]
  mcpTools: McpToolMeta[]
}
