# Claude Code CLI Source Architecture Review

## Executive Summary

This repository is an extracted and partially reconstructed TypeScript source tree for Claude Code `v2.1.88`, not a clean first-party monorepo. The codebase is large, highly feature-gated, and optimized for a production CLI that combines:

- an interactive terminal UI,
- a headless SDK/streaming mode,
- an agent loop with tool use,
- plugin, skill, MCP, and agent extension surfaces,
- strong operational instrumentation,
- a large amount of product policy, growth-flag, and enterprise control logic.

The architecture is strongest where it treats the system as a layered runtime:

1. boot and environment setup,
2. command and session configuration,
3. tool assembly and permission filtering,
4. query execution,
5. extension and remote integration.

It is weakest where too much product logic is concentrated in a few enormous orchestration files, especially `src/main.tsx` and `src/query.ts`, and where feature gating creates a wide gap between the observable public source and the intended internal design.

## Scope And Confidence

### Confirmed

The following is directly supported by source in this repository:

- command registration and CLI boot flow
- tool registry and permission-aware tool exposure
- query loop structure
- QueryEngine abstraction for headless / SDK usage
- MCP client and config loading architecture
- plugin and skill loading surfaces
- session and app state shape
- build limitations and feature-gated missing modules

### Strong Inference

The following is inferred from wiring, comments, and dead-code-eliminated branches:

- internal Anthropic builds use substantially more capabilities than this extracted repo exposes
- the public package is a reduced build with compile-time feature removal
- some systems were designed for a larger multi-agent / remote-control / internal operations environment than what is recoverable here

### Unknown Or Incomplete

- internal-only modules behind `feature()` gates
- complete implementations of some ant-only tools and product workflows
- fidelity of any reconstructed build relative to the original internal runtime

## Source Baseline

The repository README explicitly states this is extracted from the published npm package and that many feature-gated modules are missing. It also states the included build is only a best-effort reconstruction rather than a faithful rebuild.

Relevant source:

- `README.md`
- `scripts/build.mjs`

## High-Level Architecture

At a high level, the project is a production agent shell wrapped around a terminal-first application runtime.

```text
CLI Entrypoint / Commander
  -> startup prefetch + config + trust + migrations
  -> setup()
  -> commands / tools / agents / MCP / plugins assembled
  -> REPL mode or print/SDK mode
  -> QueryEngine / query()
  -> model responses
  -> tool orchestration + permissions + hooks + compaction
  -> session persistence / telemetry / UI updates
```

The most important architectural anchors are:

- `src/main.tsx`
- `src/commands.ts`
- `src/tools.ts`
- `src/QueryEngine.ts`
- `src/query.ts`
- `src/Tool.ts`
- `src/bootstrap/state.ts`
- `src/state/AppStateStore.ts`

## Component Map

### 1. Entrypoint And Boot Layer

Primary files:

- `src/main.tsx`
- `src/interactiveHelpers.tsx`
- `src/replLauncher.tsx`
- `src/bootstrap/state.ts`

What it does:

- parses top-level CLI options and subcommands with Commander
- performs eager environment setup and migrations
- handles special entrypoint rewrites such as remote-connect URLs and assistant / SSH modes
- initializes telemetry sinks, settings, managed settings, policy limits, and prefetches
- prepares the runtime for either interactive REPL usage or non-interactive print/SDK usage

Notable traits:

- startup is aggressively optimized with prefetching and overlapping async work
- the boot path contains trust-aware behavior, especially around commands that may execute repo-controlled configuration
- entrypoint mode is environment-sensitive and doubles as product telemetry / routing metadata

Tech underneath:

- Commander.js
- React/Ink for TUI paths
- environment-variable-driven behavior
- heavy lazy imports to reduce cold-start cost
- global bootstrap state for cross-cutting session metadata

Assessment:

- Good: strong operational thinking; startup cost is clearly treated as a first-class engineering concern
- Good: explicit trust commentary around potentially dangerous repo-controlled execution
- Bad: `main.tsx` is an orchestration monolith and has too many responsibilities
- Bad: mode handling is powerful but difficult to reason about because the decision tree is spread across flags, env, feature gates, and runtime checks

Relevant source:

- `src/main.tsx`
- `src/bootstrap/state.ts`

### 2. Command System

Primary files:

- `src/commands.ts`
- `src/types/command.ts`
- `src/commands/*`

What it does:

- registers built-in slash commands
- conditionally includes feature-gated commands
- loads dynamic commands from skills, plugins, workflows, and bundled sources
- applies availability and enablement filtering at runtime

Architectural pattern:

- command descriptors are metadata-first objects
- commands can be prompt-driven, local JSX-driven, or lazy-loaded
- commands are aggregated from multiple sources, not just compiled-in code

What is done well:

- the command model is extensible
- built-in and external command sources share one registry path
- lazy loading keeps large commands off the hot path

What is done poorly:

- the command surface is broad enough that the registry becomes product inventory rather than a clean bounded interface
- feature gating plus dynamic sources makes true command discovery non-trivial
- “command” spans several different execution modes, which weakens conceptual cohesion

Relevant source:

- `src/commands.ts`
- `src/skills/loadSkillsDir.ts`

### 3. Tool System

Primary files:

- `src/Tool.ts`
- `src/tools.ts`
- `src/services/tools/toolExecution.ts`
- `src/services/tools/toolOrchestration.ts`
- `src/services/tools/StreamingToolExecutor.ts`
- `src/tools/*`

What it does:

- defines the common tool interface and runtime context
- registers all base tools
- filters tools against permissions, feature gates, environment, and mode
- executes tools with hooks, telemetry, error handling, concurrency control, and interruption semantics

Core model:

- tools are the real action surface of the agent
- `ToolUseContext` is the shared runtime spine that gives tools access to app state, abort control, messages, permissions, MCP resources, and UI hooks
- tool execution is not a trivial function call; it is a policy-aware execution framework

Important tool families observed:

- shell and filesystem tools
- edit/write/notebook tools
- web fetch and web search
- MCP tools and MCP auth
- agent / team / task tools
- plan mode tools
- worktree tools
- optional LSP, browser, cron, workflow, and feature-gated tools

What is done well:

- strong abstraction around tool execution
- explicit concurrency-safe vs serial execution model
- good support for streaming and progressive result handling
- permission checks and hook integration are treated as core, not bolt-ons

What is done poorly:

- the tool context is extremely broad, which increases coupling
- tools have become the convergence point for many unrelated concerns: permissions, UI, telemetry, app state, hooks, MCP, and background tasks
- the execution subsystem is robust but complex enough that debugging emergent behavior will be costly

Relevant source:

- `src/Tool.ts`
- `src/tools.ts`
- `src/services/tools/toolOrchestration.ts`
- `src/services/tools/toolExecution.ts`
- `src/services/tools/StreamingToolExecutor.ts`

### 4. Query Engine And Agent Loop

Primary files:

- `src/QueryEngine.ts`
- `src/query.ts`
- `src/query/config.ts`
- `src/query/deps.ts`
- `src/query/stopHooks.ts`
- `src/query/tokenBudget.ts`

What it does:

- owns multi-turn conversation state
- builds system and user context
- feeds messages to the model
- handles tool-use stops, retries, compaction, token budgeting, and recovery paths
- streams messages and events to either REPL or SDK consumers

Architectural split:

- `QueryEngine` is the higher-level session object
- `query()` is the lower-level async generator implementing the turn loop

This is a sensible split. `QueryEngine` coordinates session lifecycle, whereas `query.ts` handles the model/tool interaction machinery.

Important behaviors present in the loop:

- tool-use execution and result injection
- streaming result handling
- prompt-too-long and max-output recovery
- compaction and microcompaction
- token budget tracking
- attachment and memory handling
- hook execution after sampling or stop events

What is done well:

- the query path is clearly treated as the product core
- recovery cases are documented and engineered rather than ignored
- there is a strong async-generator design that works well for both streaming UI and SDK output

What is done poorly:

- `src/query.ts` is too large to be a healthy unit
- too many product features terminate in the main loop, making it a policy and product nexus rather than a narrow execution engine
- the number of special cases suggests the system has accumulated operational scar tissue

Relevant source:

- `src/QueryEngine.ts`
- `src/query.ts`

## Runtime Flows

### Startup Flow

```text
process start
  -> preload MDM / keychain / startup profiling
  -> parse mode and entrypoint
  -> eager settings load
  -> Commander setup
  -> preAction init
  -> migrations + remote settings + policy limits
  -> MCP config loading
  -> setup()
  -> register bundled skills/plugins
  -> load commands, agents, tools
  -> launch REPL or print path
```

The startup design is highly tuned. It overlaps I/O, defers expensive work until trust or first render, and memoizes aggressively.

This is one of the strongest parts of the codebase from an operational engineering standpoint.

### Query And Tool Flow

```text
user prompt
  -> QueryEngine.submitMessage()
  -> context assembly + tool/command setup
  -> query()
  -> API request
  -> assistant response
    -> if tool_use:
       -> permission + hook checks
       -> tool execution
       -> tool_result messages
       -> continue loop
    -> else:
       -> final assistant output
  -> persistence + telemetry + usage accounting
```

### Extension Loading Flow

```text
bundled skills/plugins
  + on-disk skills
  + plugin commands
  + plugin skills
  + workflow commands
  -> merged command registry

settings / project / user / enterprise / plugins / explicit flags
  -> merged MCP config
  -> dedup + scope tagging
  -> client connections
  -> MCP tools, commands, resources
```

## State Architecture

### Bootstrap State

Primary file:

- `src/bootstrap/state.ts`

Role:

- process-global session state
- metrics, telemetry handles, model state, session identity, prompt cache latches, flags, runtime mode, and many cross-cutting switches

This file is effectively a global service locator plus state bag. The comments explicitly warn against adding more state, which is itself a signal that this module is overloaded.

Strength:

- very practical for a CLI with many subsystems and no single DI container

Weakness:

- high coupling
- difficult to test in isolation
- easy for features to leak global concerns into unrelated modules

### AppState

Primary file:

- `src/state/AppStateStore.ts`

Role:

- interactive session state for REPL/TUI behavior
- tasks, notifications, remote state, MCP state, plugin state, UI flags, thinking flags, teammate views, and tool permission context

This is a large UI/runtime state model that mixes:

- user interface state,
- background task state,
- extension state,
- session execution state,
- remote bridge state.

It is understandable in a pragmatic sense, but not especially clean.

Strength:

- one large typed state shape makes many UI interactions easier to wire

Weakness:

- boundaries between UI state and domain/runtime state are blurred

## Extension Systems

### Skills

Primary file:

- `src/skills/loadSkillsDir.ts`

What it does:

- loads markdown-defined skills / commands
- parses frontmatter metadata
- supports descriptions, arguments, hooks, tool allowlists, effort, model overrides, and execution context
- integrates MCP-derived skill builders

This is a strong example of turning content files into executable command surfaces. It is flexible and aligns with Claude Code’s extensibility model.

What is good:

- frontmatter-based skill metadata is expressive
- command generation from markdown is a strong product idea
- supports controlled execution context and tool restrictions

What is weak:

- the skill system touches many other concerns, including settings, gitignore, frontmatter semantics, shell execution, and MCP-derived behavior
- discoverability and debugging become hard when behavior comes from dynamically loaded markdown rather than code

### Plugins

Primary files:

- `src/services/plugins/PluginInstallationManager.ts`
- `src/utils/plugins/*`
- `src/plugins/*`

What it does:

- tracks installed/enabled/disabled plugins
- supports marketplaces and background installation reconciliation
- refreshes active plugins and reconnects plugin-provided MCP servers

Strengths:

- plugin activation is treated as a live system, not just startup-only configuration
- background reconciliation and deferred refresh are operationally thoughtful

Weaknesses:

- plugin state is spread across app state, bootstrap helpers, loaders, reconcilers, and MCP integration
- lifecycle clarity depends on reading several subsystems together

### MCP

Primary files:

- `src/services/mcp/client.ts`
- `src/services/mcp/config.ts`
- `src/services/mcp/types.ts`
- `src/services/mcp/*`

What it does:

- loads MCP server configs from multiple scopes
- deduplicates and scopes configurations
- supports stdio, SSE, streamable HTTP, WebSocket, and SDK-controlled transports
- exposes MCP tools, commands, prompts, and resources into the runtime
- handles auth, OAuth refresh, session expiry, output truncation, persistence, and elicitation

This is one of the most mature subsystems in the codebase.

What is done well:

- multiple transport support
- strong config merging and dedup
- practical handling of auth/session expiry
- clear awareness of prompt-size pressure from MCP tool descriptions

What is done poorly:

- MCP concerns are broad enough that the client module becomes another orchestration center
- the subsystem is powerful but operationally heavy; support burden would be high

## Remote, Bridge, And Multi-Agent Surfaces

Observed areas:

- `src/remote/*`
- bridge and remote-control branches in `src/main.tsx`
- agent tooling in `src/tools/AgentTool/*`
- task framework in `src/Task.ts`
- remote session state in `src/state/AppStateStore.ts`

What it appears to support:

- remote sessions
- bridge / viewer style operation
- background and local agents
- tasks as first-class runtime objects
- optional teammate / swarming / assistant behavior

This area is more difficult to assess fully because many advanced capabilities are feature-gated or partially absent in this extracted source. Still, the architecture shows that the CLI was designed as more than a local prompt shell; it is a client/runtime for a wider session-and-agent system.

Strength:

- the architecture anticipates long-lived, multi-process, and remote interaction patterns

Weakness:

- public-source comprehensibility drops sharply once the code enters these gated areas

## Permissions, Trust, And Safety Model

This is a central architectural theme of the codebase.

Major mechanisms observed:

- permission modes
- allow/deny/ask rule sets
- trust gating for project-controlled config
- dangerous mode toggles
- hook-based pre/post tool checks
- sandbox integration
- tool filtering prior to model exposure

This is not just a CLI with some commands. It is an execution harness that assumes model autonomy is dangerous unless constrained.

What is done well:

- safety is built into the architecture, not patched on afterward
- the trust model is explicitly acknowledged in comments
- permissions affect both tool exposure and tool execution, which is the correct design

What is done poorly:

- the number of safety layers increases reasoning complexity
- global state and feature gates make it hard to prove behavior compositionally

## Build And Packaging Model

Primary files:

- `package.json`
- `scripts/prepare-src.mjs`
- `scripts/build.mjs`

What it does:

- patches Bun-specific compile-time constructs
- replaces feature checks and macros
- stubs missing modules where necessary
- bundles a best-effort `dist/cli.js`

Assessment:

- good as a research reconstruction pipeline
- not a clean build system for long-term development
- strong evidence that the “real” system depends on a larger internal build environment

## Observability And Product Control

Cross-cutting systems observed:

- analytics
- feature flags / GrowthBook
- remote managed settings
- policy limits
- tracing / counters / OTel-style metrics
- startup profiling and query profiling

This is a highly operationalized client. It behaves like a product runtime, not a hobby CLI. That is one of the clearest architectural signals in the codebase.

Strength:

- excellent instrumentation mindset

Weakness:

- many product and operational controls sit in the same files as execution logic, reducing conceptual purity

## What The Project Does Well

### Strong production harness

The project wraps the agent loop with real infrastructure: permissions, hooks, telemetry, session persistence, plugins, MCP, remote support, and recovery paths.

### Good layering at the macro level

Despite local complexity, the macro architecture is sensible:

- boot
- command setup
- tool exposure
- query loop
- state and extension layers

### Extensibility is a first-class goal

The plugin, skill, MCP, and agent systems are not afterthoughts.

### Startup engineering is thoughtful

The startup path shows careful performance work, especially around prefetch, trust, lazy import, and overlapping I/O.

### Permission-aware tooling is well-conceived

Filtering tools before exposing them to the model is a strong architectural decision.

## What The Project Does Poorly

### Orchestration monoliths

The largest architectural weakness is concentration of control flow in a few very large files:

- `src/main.tsx`
- `src/query.ts`
- large parts of MCP and tool execution layers

This raises maintenance cost and makes local reasoning difficult.

### Too much global state

`src/bootstrap/state.ts` in particular carries too many cross-cutting concerns. The warning comments in the file are justified.

### Feature-gate complexity

Feature-gated imports are understandable for product builds, but they reduce readability and make public-source comprehension significantly harder.

### Mixed responsibilities

Many modules combine:

- product logic,
- operational instrumentation,
- policy enforcement,
- execution flow.

That is pragmatic, but not clean.

### Weak discoverability of dynamic behavior

Skills, plugins, hooks, settings, MCP configs, and feature gates all mutate runtime behavior. This is powerful but increases the cognitive load required to answer “what does this system do right now?”

## Architectural Suggestions

### 1. Split `main.tsx` into explicit startup phases

Suggested modules:

- `startup/argv.ts`
- `startup/init.ts`
- `startup/modeSelection.ts`
- `startup/extensions.ts`
- `startup/replLaunch.ts`

Benefit:

- lower orchestration entropy
- easier testability
- clearer startup ownership

### 2. Continue extracting the query loop

`src/QueryEngine.ts` is already a move in the right direction. Continue by separating:

- message preparation
- recovery logic
- compaction policy
- tool-stop handling
- stream emission

### 3. Reduce global bootstrap state

Move process-global state into narrower services where possible:

- metrics service
- prompt cache service
- session identity service
- runtime mode service

### 4. Introduce clearer bounded contexts

Current subsystems are present, but boundaries are weak. Formalize them around:

- execution core
- UI runtime
- extensions
- transport/remoting
- policy/safety
- observability

### 5. Add architecture-level docs in source

This codebase would benefit from maintainer docs for:

- startup sequence
- query lifecycle
- permission evaluation order
- MCP merge order
- plugin refresh lifecycle

### 6. Normalize dynamic-extension precedence rules

Commands, skills, plugins, MCP, and settings each have precedence logic. Make precedence a documented reusable model, not just implementation detail.

## Tech Stack Summary

Observed core technologies:

- TypeScript
- Node.js runtime target
- Bun-oriented source assumptions in the original upstream build
- Commander for CLI parsing
- React + Ink for terminal UI
- Anthropic SDK integration
- Model Context Protocol SDK
- lodash-es utilities
- zod schemas
- OpenTelemetry-style instrumentation components

## Final Assessment

This is a sophisticated agent runtime wrapped in a terminal application, not merely a CLI wrapper around an API.

Its architecture is best understood as:

- a production agent harness,
- a TUI application,
- a dynamic extension platform,
- and a policy/instrumentation heavy product client.

The design shows strong engineering in startup performance, extensibility, permission-aware tooling, and operational hardening. The main liabilities are orchestration sprawl, global state, and feature-gate-driven complexity.

If this were an internal codebase I was inheriting, I would judge it as:

- functionally impressive,
- operationally mature,
- architecturally pragmatic,
- but in need of sustained decomposition work to remain maintainable.

## Appendix: Anchor Files

If you want to understand the project quickly, read these first:

1. `src/main.tsx`
2. `src/commands.ts`
3. `src/tools.ts`
4. `src/Tool.ts`
5. `src/QueryEngine.ts`
6. `src/query.ts`
7. `src/services/tools/toolExecution.ts`
8. `src/services/mcp/client.ts`
9. `src/services/mcp/config.ts`
10. `src/bootstrap/state.ts`
11. `src/state/AppStateStore.ts`
12. `src/skills/loadSkillsDir.ts`

## Appendix: Key Observations From Source

- `src/main.tsx` is the primary boot orchestrator and command host.
- `src/commands.ts` merges built-in, skill, plugin, workflow, and dynamic command sources.
- `src/tools.ts` is the base tool registry and feature-gated capability switchboard.
- `src/Tool.ts` defines a large shared runtime contract for tools.
- `src/query.ts` contains the main loop and many operational recovery paths.
- `src/QueryEngine.ts` is the cleaner higher-level abstraction for headless and SDK use.
- `src/services/mcp/client.ts` is a full MCP integration layer, not a thin adapter.
- `src/services/mcp/config.ts` implements multi-scope MCP config merging and deduplication.
- `src/bootstrap/state.ts` is the main process-global state concentration point.
- `src/state/AppStateStore.ts` is the interactive runtime state model.
