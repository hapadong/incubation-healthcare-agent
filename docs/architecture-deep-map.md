# Claude Code Deep Component Map

## Purpose

This document expands the architecture review into a more granular component map. It focuses on:

- directory-level segmentation,
- responsibility boundaries,
- major dependency hubs,
- runtime dependency direction,
- architectural hotspots.

It is intended as a maintainer-oriented map rather than an end-user summary.

## Reading Strategy

If you are new to this codebase, read in this order:

1. `src/main.tsx`
2. `src/commands.ts`
3. `src/tools.ts`
4. `src/Tool.ts`
5. `src/QueryEngine.ts`
6. `src/query.ts`
7. `src/services/tools/*`
8. `src/services/mcp/*`
9. `src/bootstrap/state.ts`
10. `src/state/AppStateStore.ts`

## Top-Level Directory Segments

### Runtime Core

- `src/main.tsx`
- `src/QueryEngine.ts`
- `src/query.ts`
- `src/Tool.ts`
- `src/Task.ts`
- `src/history.ts`
- `src/interactiveHelpers.tsx`

Role:

- boot the application
- own the main query lifecycle
- define execution abstractions for tools and tasks
- mediate between terminal UI and headless flows

### Commands

- `src/commands/*`
- `src/commands.ts`

Role:

- expose slash-command and subcommand behaviors
- bridge product workflows into the main runtime

### Tools

- `src/tools/*`
- `src/tools.ts`
- `src/services/tools/*`

Role:

- define the model action surface
- execute user/model actions under permissions, hooks, and telemetry

### Extensions

- `src/skills/*`
- `src/plugins/*`
- `src/services/plugins/*`
- `src/utils/plugins/*`

Role:

- make behavior extensible from markdown, plugins, marketplaces, and built-ins

### MCP Integration

- `src/services/mcp/*`
- `src/tools/MCPTool/*`
- `src/tools/ListMcpResourcesTool/*`
- `src/tools/ReadMcpResourceTool/*`
- `src/tools/McpAuthTool/*`

Role:

- connect external capability providers into the CLI
- normalize remote tools/resources/prompts into local runtime primitives

### State And UI

- `src/state/*`
- `src/context/*`
- `src/screens/*`
- `src/components/*`
- `src/ink/*`

Role:

- power the REPL/TUI and session visualization

### Services

- `src/services/api/*`
- `src/services/compact/*`
- `src/services/analytics/*`
- `src/services/lsp/*`
- `src/services/oauth/*`
- `src/services/policyLimits/*`
- `src/services/remoteManagedSettings/*`

Role:

- provide cross-cutting infrastructure and product services

### Utilities

- `src/utils/*`

Role:

- everything from permissions to settings, git, telemetry, storage, model routing, and prompt building

This is the broadest support layer in the repo.

### Remote / Server / Bridge

- `src/remote/*`
- `src/server/*`
- `src/bridge/*`
- `src/cli/transports/*`

Role:

- remote session transport
- session ingress / direct connect
- remote viewers and bridge-style interactions

### Tasks And Multi-Agent Runtime

- `src/tasks/*`
- `src/tools/AgentTool/*`
- `src/state/teammateViewHelpers.ts`

Role:

- spawn, monitor, view, and stop agent-like background work

## Dependency Hubs

These files are the clearest dependency hubs in the current architecture.

### `src/main.tsx`

Why it is a hub:

- imports boot helpers
- imports settings, auth, policy, MCP, plugins, REPL launch, tools, commands, agents, analytics, and many utilities
- owns startup sequencing and mode branching

Architectural meaning:

- this is the composition root
- it is also a product policy root
- it is also a startup performance root

Risk:

- too many reasons to change

### `src/query.ts`

Why it is a hub:

- imports compaction, analytics, message transformation, API helpers, attachment logic, hooks, token budgeting, tool executors, and query config

Architectural meaning:

- this is the core state machine for the agent loop

Risk:

- it accumulates product-specific recovery and behavioral complexity

### `src/QueryEngine.ts`

Why it is a hub:

- glues together session state, commands, tools, app state, persistence, model invocation, and SDK output

Architectural meaning:

- cleaner than `query.ts`, but still a high-level coordinator

Risk:

- useful abstraction that could degrade if too many responsibilities keep migrating upward

### `src/services/mcp/client.ts`

Why it is a hub:

- imports MCP SDK transports and schemas
- imports auth, prompt/resource/tool normalization, output storage, proxying, session ingress, IDE integration, telemetry, and config

Architectural meaning:

- MCP is not a side feature; it is effectively a second execution substrate

Risk:

- large integration surface with high operational complexity

### `src/bootstrap/state.ts`

Why it is a hub:

- stores process-global session and runtime state used by many subsystems

Architectural meaning:

- global control plane

Risk:

- hidden coupling and hard-to-localize side effects

## Dependency Direction

The intended dependency shape appears to be roughly:

```text
UI / CLI commands
  -> runtime orchestration
    -> services
      -> utils
        -> platform / storage / protocol primitives
```

In reality, the code often bends this:

- orchestration imports utilities directly
- services import tools or UI-adjacent helpers in some cases
- global bootstrap state is reachable from many layers
- `src` alias imports bypass some local path expectations and flatten boundaries

## Core Runtime Decomposition

### A. Boot And Mode Selection

Primary files:

- `src/main.tsx`
- `src/entrypoints/*`
- `src/setup.ts`

Sub-responsibilities:

- parse argv
- determine interactive vs non-interactive
- initialize session metadata
- start background prefetches
- handle trust and setup flows
- launch REPL or headless path

Dependency shape:

```text
main.tsx
  -> init / setup
  -> commands / tools / agents
  -> policy limits / managed settings / analytics
  -> MCP config and resource prefetch
  -> launchRepl or print/SDK flow
```

Assessment:

- coherent at a macro level
- too centralized in one file

### B. Command Layer

Primary files:

- `src/commands.ts`
- `src/commands/*`

Sub-responsibilities:

- register built-ins
- merge skills/plugins/workflows
- apply auth/provider availability checks
- expose user command vocabulary

Dependency shape:

```text
commands.ts
  -> built-in command modules
  -> skill loader
  -> plugin command loader
  -> bundled skill/plugin command providers
```

Assessment:

- good extension aggregation point
- weak conceptual purity because “commands” include very different execution styles

### C. Tool Layer

Primary files:

- `src/Tool.ts`
- `src/tools.ts`
- `src/services/tools/*`

Sub-responsibilities:

- define tool contracts
- build base tool set
- manage permission-aware tool exposure
- execute tool uses
- stream progress and results

Dependency shape:

```text
tools.ts
  -> concrete tool implementations
  -> feature gates
  -> permission filters

toolExecution.ts
  -> tool lookup
  -> permission checks
  -> hooks
  -> telemetry
  -> tool result shaping
```

Assessment:

- a strong and intentional subsystem
- one of the most reusable parts of the architecture

### D. Query Layer

Primary files:

- `src/QueryEngine.ts`
- `src/query.ts`
- `src/services/api/claude.ts`

Sub-responsibilities:

- maintain messages
- prepare model requests
- stream model output
- detect tool stops
- run tool calls
- compact or recover as needed

Dependency shape:

```text
QueryEngine
  -> processUserInput
  -> fetchSystemPromptParts
  -> query()

query()
  -> API layer
  -> attachment/memory builders
  -> compaction services
  -> tool execution services
  -> hook handlers
```

Assessment:

- architecturally central
- technically powerful
- hardest place to safely modify

### E. State Layer

Primary files:

- `src/bootstrap/state.ts`
- `src/state/AppStateStore.ts`
- `src/state/store.ts`

Sub-responsibilities:

- global session and telemetry state
- UI state
- task state
- plugin/MCP state
- teammate and remote state

Dependency shape:

```text
bootstrap/state.ts
  <- many runtime modules

AppStateStore.ts
  <- REPL/UI, tools, tasks, plugins, MCP
```

Assessment:

- practical but overloaded
- boundaries between runtime state and UI state are weak

## Extension Surfaces

### Skills

Key modules:

- `src/skills/loadSkillsDir.ts`
- `src/skills/mcpSkillBuilders.ts`
- `src/skills/bundled/*`

Dependency pattern:

- file system
- markdown/frontmatter parsing
- settings source resolution
- dynamic command generation

This is content-as-code with execution metadata.

### Plugins

Key modules:

- `src/services/plugins/PluginInstallationManager.ts`
- `src/utils/plugins/loadPluginCommands.ts`
- `src/utils/plugins/pluginLoader.ts`
- `src/utils/plugins/reconciler.ts`

Dependency pattern:

- config
- marketplace metadata
- cache management
- MCP integration
- app state refresh

Plugins are not isolated add-ons; they can shape commands, skills, MCP config, and runtime refresh behavior.

### MCP

Key modules:

- `src/services/mcp/client.ts`
- `src/services/mcp/config.ts`
- `src/services/mcp/auth.ts`

Dependency pattern:

- transport SDK
- auth
- output storage and truncation
- config merging
- runtime tool/resource generation

MCP is effectively a distributed extension fabric.

## Tasks And Agent Subsystem

Primary files:

- `src/Task.ts`
- `src/tasks/*`
- `src/tools/AgentTool/*`

What stands out:

- tasks are explicit typed runtime entities
- agents are implemented as tools plus task infrastructure, not as a separate hidden subsystem
- the app state carries task visibility and foreground/view state

Dependency shape:

```text
AgentTool
  -> task spawning
  -> agent definitions
  -> built-in agents
  -> task progress + UI integration
```

This is a good design choice. It keeps agent work inside the same execution worldview as other actions.

## Permissions Subsystem Map

Relevant areas:

- `src/utils/permissions/*`
- `src/hooks/toolPermission/*`
- filesystem safety logic
- rule parsing and persistence
- classifier-assisted decisions

Major concerns handled:

- path safety
- working-directory allowlists
- dangerous removals
- shell command rule matching
- persisted allow/deny rules
- auto-mode / classifier gating

Architectural note:

The permissions system is not just a prompt-time policy layer. It is a runtime execution framework with state, persistence, and classifier integration.

## Compaction And Memory Subsystem Map

Relevant areas:

- `src/services/compact/*`
- `src/services/SessionMemory/*`
- `src/services/extractMemories/*`
- `src/memdir/*`

Observed responsibilities:

- auto-compact and microcompact
- post-compact cleanup
- session memory prompt building
- extracted memory generation
- prompt context shaping over long sessions

Architectural note:

This codebase assumes that long-running agent sessions are normal and require active context-shaping infrastructure.

## API Layer Map

Relevant areas:

- `src/services/api/claude.ts`
- `src/services/api/client.ts`
- `src/services/api/errors.ts`
- `src/services/api/logging.ts`
- `src/services/api/filesApi.ts`
- `src/services/api/bootstrap.ts`

Observed responsibilities:

- model request construction
- streaming and non-streaming API execution
- usage accounting
- prompt caching behavior
- task-budget parameters
- bootstrap and file APIs

Architectural note:

The API layer is not generic. It is tightly aligned to product behavior, caching strategy, analytics, and recovery semantics.

## Architectural Hotspots

These are the areas most likely to cause maintenance pain:

### `src/main.tsx`

- too many startup responsibilities
- too many mode branches
- too many direct imports from distant subsystems

### `src/query.ts`

- too much product behavior embedded into the loop
- recovery and compaction logic mixed with core execution flow

### `src/bootstrap/state.ts`

- global mutable state concentration

### `src/services/mcp/client.ts`

- very broad integration surface

### `src/utils/*`

- the utility layer is effective but sprawling
- some utilities are really subsystem code and should likely be promoted

## Suggested Refactoring Order

If this codebase were being actively maintained, I would decompose in this order:

1. `src/main.tsx` into startup-phase modules
2. `src/query.ts` into smaller query-loop stages
3. split bootstrap state into narrower services
4. formalize extension lifecycle docs and precedence rules
5. separate UI state from runtime execution state where possible
6. promote some `utils/*` areas into proper subsystems

## Short Dependency Diagrams

### Boot

```text
main.tsx
  -> init/setup
  -> commands.ts
  -> tools.ts
  -> MCP config/client
  -> REPL launcher
  -> global bootstrap state
```

### Agent Loop

```text
QueryEngine.ts
  -> query.ts
    -> services/api/claude.ts
    -> services/tools/*
    -> services/compact/*
    -> utils/messages/*
    -> hooks / permissions
```

### Extension Plane

```text
skills + plugins + MCP
  -> commands registry
  -> tools/resources/prompts
  -> app state + refresh + reconnect paths
```

## Bottom Line

This codebase is best thought of as a layered execution platform whose main interfaces are:

- commands,
- tools,
- sessions,
- extensions,
- and transport/runtime modes.

Its architectural challenge is not lack of structure. It has structure. The challenge is that too much real-world product behavior is concentrated into a few orchestration-heavy hubs, which makes the system harder to change than to understand.
