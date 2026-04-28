# HealthAgent v0.2.0 — Development Plan

**Base:** HealthAgent v0.1.0 (Claude Code v2.1.88 source)
**Goal:** Web UI that shares 100% of the CLI core — same agent loop, same MCP servers, same skills
**Target:** Same individual clinicians and researchers as v0.1.0, now with browser access
**Status:** Planning — this file captures architecture decisions and full task list

---

## Context: What v0.1.0 Delivered

v0.1.0 is a fully functional local-first CLI clinical assistant:
- 7 clinical MCP servers (pubmed, trials, drugs, coding, guidelines, mimic, patients)
- 4 clinical skills (/lit-review, /drug-check, /trial-match, /visit-prep)
- 13 multi-agent oncology team roles (/team-review)
- PHI scanner + append-only audit log
- FHIR-aligned patient schema v1
- Session persistence with cross-day resume

v0.2.0 adds a web UI as a **second output adapter** — no new core logic, no duplication.

---

## Core Principle: One Set of Core Functions

```
initBuiltinPlugins()
initBundledSkills()
getCommands(cwd)                   ← skills auto-discovered here
getClaudeCodeMcpConfigs()          ← MCP servers from settings.json
getMcpToolsCommandsAndResources()  ← connects to all configured MCPs
assembleToolPool()                 ← built-in tools + MCP tools merged
QueryEngine.submitMessage()        ← single agent loop, shared by both
        ↓
AsyncGenerator<SDKMessage>         ← same typed message stream

CLI path:  generator → React/Ink renderer → terminal
Web path:  generator → SSE stream      → browser
```

**Nothing in the agent loop, tool system, MCP layer, or skill layer changes.**
Adding a new MCP server or skill = it appears in the web UI automatically, zero web-specific work.

---

## Architecture Overview

### Current (v0.1.0)

```
cli.tsx → main.tsx → QueryEngine → React/Ink → terminal
```

### Target (v0.2.0)

```
cli.tsx  → main.tsx        → QueryEngine → React/Ink → terminal
web.ts   → engineFactory   → QueryEngine → Hono SSE  → browser
                ↑
         shared init layer (extracted from main.tsx)
```

### Deployment Model (unchanged from v0.1.0)

```
Browser → localhost:3000 → local web.ts server → QueryEngine → local MCP servers
                                                              ↓
                                                     ~/.healthagent/
                                                     ├── patients/
                                                     ├── sessions/
                                                     └── audit/
```

Same local-first constraint. The web server runs on the user's own machine. No patient data leaves
the workstation. The browser is just a richer terminal.

---

## New Files to Create

```
src/
├── shared/
│   └── engineFactory.ts         ← extract init logic from main.tsx; used by both CLI and web
│
├── entrypoints/
│   └── web.ts                   ← Hono HTTP server (SSE, session store, API routes)
│
└── web/
    ├── index.html               ← SPA shell (single HTML file, no routing needed)
    ├── app.tsx                  ← React root: layout, session state, SSE consumer
    └── components/
        ├── ChatMessage.tsx      ← renders assistant text (streaming, markdown)
        ├── ToolBlock.tsx        ← collapsible tool input/output block
        ├── MCPResult.tsx        ← distinct rendering for MCP tool calls
        ├── CommandInput.tsx     ← chat input + slash command autocomplete
        ├── PermissionModal.tsx  ← permission prompt dialog (approve/deny)
        ├── SidebarPanel.tsx     ← MCP server status + session list
        └── StreamingText.tsx    ← token-by-token text rendering
```

Files **not** changed: everything under `src/tools/`, `src/services/`, `src/utils/healthagent/`,
`src/entrypoints/cli.tsx`, `src/main.tsx`, `src/QueryEngine.ts`, `src/query.ts`, all MCP servers.

---

## API Design

### Routes

| Method | Route | Purpose |
|--------|-------|---------|
| `POST` | `/api/chat` | Send a message; creates or continues a session |
| `GET` | `/api/stream/:sessionId` | SSE stream of `SDKMessage` NDJSON until turn complete |
| `POST` | `/api/control/:sessionId` | Browser replies to a permission prompt (approve/deny) |
| `GET` | `/api/meta` | Returns available commands list + MCP tool list (for autocomplete) |
| `GET` | `/*` | Serve static frontend (index.html + bundled JS) |

### Request/Response Shapes

**POST /api/chat**
```typescript
// Request
{ message: string; sessionId?: string }

// Response
{ sessionId: string }
// Then: GET /api/stream/:sessionId begins yielding
```

**GET /api/stream/:sessionId** — SSE stream, one `SDKMessage` per frame:
```
data: {"type":"assistant","message":{"role":"assistant","content":[...]},...}
data: {"type":"system","subtype":"status",...}
data: {"type":"result","subtype":"success",...}
```
Stream closes when `SDKResultMessage` is received (subtype: `success` or `error_*`).

**POST /api/control/:sessionId**
```typescript
// Browser sends after receiving a control_request SSE frame
{ requestId: string; decision: "allow" | "deny"; allowAlways?: boolean }
```

**GET /api/meta**
```typescript
// Response
{
  commands: Array<{ name: string; description: string; isSkill: boolean }>,
  mcpTools: Array<{ name: string; server: string; description: string }>,
  mcpServers: Array<{ name: string; status: "connected" | "error" | "disabled" }>
}
```

### Session Store

In-memory Map per process (sufficient for local single-user deployment):

```typescript
type WebSession = {
  engine: QueryEngine
  appState: AppState
  pendingControl: Map<string, (decision: ControlDecision) => void>  // for permission prompts
  createdAt: Date
  lastActiveAt: Date
}

const sessions = new Map<string, WebSession>()
```

Sessions expire after 2 hours of inactivity (same as CLI session timeout).

---

## Permission Prompt Flow (Interactive/Safe Mode)

When the agent requests a tool that requires approval, the web UI shows a blocking modal. The SSE
stream pauses until the user responds. This is the same safety model as the CLI's TTY prompt.

```
Agent calls tool requiring approval
        ↓
SSE yields control_request frame:
  { type: "control_request", requestId, tool, input, description }
        ↓
Frontend shows PermissionModal:
  [ Tool name + input preview ]
  [ Allow Once ]  [ Always Allow ]  [ Deny ]
        ↓
Browser POST /api/control/:sessionId:
  { requestId, decision: "allow" | "deny", allowAlways: true/false }
        ↓
Server resolves the pending Promise in WebSession.pendingControl
        ↓
Agent loop continues (or gets deny error)
```

"Always Allow" writes the rule to the session's `alwaysAllowRules` (same as CLI `1` option).
"Deny" sends an error tool_result back to the agent (same as CLI deny).

---

## Frontend Design

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│  HealthAgent                          [New Chat] [Sessions] │
├───────────────────┬─────────────────────────────────────────┤
│                   │                                         │
│  MCP Servers      │  Chat area (scrollable)                 │
│  ─────────────    │                                         │
│  ✓ pubmed         │  [User message bubble]                  │
│  ✓ trials         │                                         │
│  ✓ drugs          │  [Assistant text — streaming]           │
│  ✓ coding         │   ▶ Tool: pubmed_search    [expand]     │
│  ✓ guidelines     │   ▶ Tool: mimic_patient    [expand]     │
│  ✓ mimic          │  [Assistant text continues]             │
│  ✓ patients       │                                         │
│                   │  [User message bubble]                  │
│  Skills           │                                         │
│  ─────────────    │  [Assistant text]                       │
│  /lit-review      │                                         │
│                   │                                         │
│  /drug-check      ├─────────────────────────────────────────┤
│  /trial-match     │  > /lit-review EGFR mutations in NSCLC  │
│  /visit-prep      │                              [Send ↵]   │
│  /team-review     │                                         │
└───────────────────┴─────────────────────────────────────────┘
```

### Message Rendering

**Assistant text:** Rendered as markdown (already using `marked` in project deps). Streams token
by token as SSE `stream_event` frames arrive.

**Tool use blocks:** Collapsible, shown inline between text chunks:
```
▶ mimic_patient  { "patient_id": "10006" }          [click to expand]

▼ mimic_patient  { "patient_id": "10006" }
  Result: { "name": "...", "age": 67, "diagnoses": [...] }
```

MCP tool calls are visually distinct from built-in tool calls (different color/icon) so the
clinician can see which data source was queried.

**Slash command autocomplete:** Typing `/` opens a dropdown populated from `GET /api/meta`.
Shows command name + description. Arrow keys to select, Enter to complete. Same commands as CLI.

**Permission modal:** Blocks the input area while pending. Shows tool name, a preview of the
input parameters, and three buttons. Cannot be dismissed without making a choice.

### Streaming

SSE stream → React state updates:
- `stream_event` frames append tokens to the current assistant message buffer
- `tool_use` frames open a new collapsed ToolBlock
- `tool_result` frames close and populate the ToolBlock
- `result` frame (final) marks the turn complete, re-enables input

### Tech Stack (frontend)

- **React 19** — already in project deps, no new dependency
- **marked** — already in deps, for markdown rendering
- **No external UI library** — keep it minimal; CSS-in-JS via inline styles or a single CSS file
- **EventSource API** — browser built-in, no library needed for SSE

---

## Build Extension

Extend `scripts/build.mjs` with a second esbuild pass:

```javascript
// Pass 1 (existing): CLI bundle
await esbuild.build({
  entryPoints: ['src/entrypoints/cli.tsx'],
  outfile: 'dist/cli.cjs',
  // ... existing config
})

// Pass 2 (new): Web server bundle
await esbuild.build({
  entryPoints: ['src/entrypoints/web.ts'],
  outfile: 'dist/web.cjs',
  platform: 'node',
  format: 'cjs',
  // ... same externals as CLI
})

// Pass 3 (new): Frontend bundle
await esbuild.build({
  entryPoints: ['src/web/app.tsx'],
  outfile: 'dist/web/app.js',
  platform: 'browser',
  format: 'esm',
  bundle: true,
  minify: true,
})
```

The web server (`dist/web.cjs`) serves `dist/web/` as static files.

**Start command:** `node dist/web.cjs` (or a new `ha-web` bin entry in package.json)

---

## Detailed Task List

### Phase 7.1 — Shared Engine Factory

**Goal:** Extract initialization from `main.tsx` into a shared function callable by both CLI and web.

- [ ] **7.1.1** Read `src/main.tsx` in full to identify exactly what init code needs extraction
- [ ] **7.1.2** Create `src/shared/engineFactory.ts` with:
  ```typescript
  export async function createEngineSession(opts: {
    cwd: string
    prompt: string
    permissionMode?: PermissionMode
  }): Promise<{ engine: QueryEngine; appState: AppState; commands: Command[] }>
  ```
  Internally calls: `initBuiltinPlugins`, `initBundledSkills`, `getCommands`, `getClaudeCodeMcpConfigs`,
  `getMcpToolsCommandsAndResources`, `assembleToolPool`
- [ ] **7.1.3** Verify CLI still works after refactor (CLI calls same factory)
- [ ] **7.1.4** Write unit smoke test: factory returns a functioning QueryEngine

### Phase 7.2 — Hono Web Server

**Goal:** HTTP server that wraps QueryEngine in SSE + REST API.

- [ ] **7.2.1** Install Hono if not in dependencies (`npm install hono`) — check first
- [ ] **7.2.2** Create `src/entrypoints/web.ts`:
  - Session store (Map<string, WebSession>)
  - Session expiry (2hr TTL, cleanup interval)
  - `POST /api/chat` handler
  - `GET /api/stream/:sessionId` SSE handler (pump AsyncGenerator → SSE frames)
  - `POST /api/control/:sessionId` handler (resolve pending permission Promise)
  - `GET /api/meta` handler (return commands + MCP tools list)
  - Static file serving for `dist/web/`
  - CORS headers for localhost dev
- [ ] **7.2.3** Wire permission prompt interception:
  - Override `canUseTool` in the session's QueryEngine config
  - If tool requires approval: create a Promise, store resolver in `session.pendingControl`
  - Emit `control_request` SSE frame with `requestId`
  - Await the Promise (stream stays open, heartbeat keep-alives sent every 15s)
  - On `POST /api/control`: resolve Promise with decision
- [ ] **7.2.4** Add `ha-web` bin entry to `package.json`
- [ ] **7.2.5** Test with `curl`: POST a message, GET the stream, verify NDJSON frames

### Phase 7.3 — Frontend: Core Shell

**Goal:** Minimal working chat that streams responses.

- [ ] **7.3.1** Create `src/web/index.html` — SPA shell with `<div id="root">`, script tag
- [ ] **7.3.2** Create `src/web/app.tsx` — React root:
  - Session state (sessionId, messages array, isStreaming flag)
  - SSE consumer (`useEffect` → `EventSource` → parse frames → update state)
  - Layout: sidebar + chat area + input bar
- [ ] **7.3.3** Create `src/web/components/StreamingText.tsx`:
  - Buffers incoming token strings
  - Renders via `marked` for markdown
  - Handles partial bold/italic at stream boundary
- [ ] **7.3.4** Create `src/web/components/ChatMessage.tsx`:
  - User message: right-aligned bubble
  - Assistant message: left-aligned, contains StreamingText + ToolBlocks inline
- [ ] **7.3.5** Wire send: input → POST /api/chat → get sessionId → open SSE stream
- [ ] **7.3.6** Test: send "hello" and see streamed response in browser

### Phase 7.4 — Frontend: Tool Blocks

**Goal:** Inline collapsible display of tool use and results, matching CLI information density.

- [ ] **7.4.1** Create `src/web/components/ToolBlock.tsx`:
  - Collapsed state: `▶ tool_name  { truncated input }`
  - Expanded state: full input JSON + full result JSON (or formatted if MCP result)
  - Distinct styling for MCP tools vs built-in tools
- [ ] **7.4.2** Create `src/web/components/MCPResult.tsx`:
  - Renders MCP tool results with server name badge (e.g., `[pubmed]`, `[mimic]`)
  - Pretty-prints structured results (tables for lab values, lists for search results)
- [ ] **7.4.3** Wire `tool_use` and `tool_result` SSE frames into ToolBlock lifecycle:
  - `tool_use` frame → open ToolBlock (pending state, spinner)
  - `tool_result` frame → populate ToolBlock (complete state)
- [ ] **7.4.4** Test: run `/lit-review EGFR NSCLC`, verify all pubmed tool calls appear inline

### Phase 7.5 — Frontend: Command Input & Autocomplete

**Goal:** Slash command autocomplete matching CLI experience.

- [ ] **7.5.1** Create `src/web/components/CommandInput.tsx`:
  - Textarea (supports multi-line for longer prompts)
  - On `/` keypress: fetch `GET /api/meta`, open autocomplete dropdown
  - Filter dropdown as user types the command name
  - Arrow keys + Enter to complete
  - Escape to dismiss
- [ ] **7.5.2** Sidebar skills list: pull from `GET /api/meta` on mount, render as clickable
  items that insert the command into the input
- [ ] **7.5.3** Sidebar MCP server status: show connected/error/disabled per server from
  `/api/meta` response, auto-refresh every 30s
- [ ] **7.5.4** Test: type `/drug`, see dropdown show `/drug-check`, select it, verify input
  is populated

### Phase 7.6 — Frontend: Permission Modal

**Goal:** Safe interactive permission prompts matching CLI behaviour.

- [ ] **7.6.1** Create `src/web/components/PermissionModal.tsx`:
  - Overlay modal (blocks input area)
  - Shows: tool name, formatted input parameters, brief description
  - Three buttons: Allow Once / Always Allow / Deny
  - On click: POST /api/control/:sessionId with decision
  - Dismisses and resumes stream
- [ ] **7.6.2** Wire SSE `control_request` frame → show modal
- [ ] **7.6.3** Wire `control_response` (confirmation) → hide modal
- [ ] **7.6.4** Test: trigger a BashTool call, verify modal appears before execution

### Phase 7.7 — Frontend: Session Management

**Goal:** Multi-turn conversations and session continuity.

- [ ] **7.7.1** Create `src/web/components/SidebarPanel.tsx`:
  - Session list: fetch from local storage (sessionIds persisted in browser)
  - New Chat button: clears state, new sessionId on next send
  - Session items: click to restore (note: restores UI state; agent memory is server-side)
- [ ] **7.7.2** Persist last sessionId in `localStorage` so page refresh continues same conversation
- [ ] **7.7.3** Session expiry notice: if server returns 404 for a session (expired), show
  "Session expired — starting new conversation" and clear
- [ ] **7.7.4** Test: multi-turn conversation, page refresh, verify context retained

### Phase 7.8 — Build Pipeline

**Goal:** `npm run build` produces CLI + web server + frontend bundle.

- [ ] **7.8.1** Read `scripts/build.mjs` in full
- [ ] **7.8.2** Add esbuild pass for `src/entrypoints/web.ts` → `dist/web.cjs`
- [ ] **7.8.3** Add esbuild pass for `src/web/app.tsx` → `dist/web-static/app.js`
- [ ] **7.8.4** Copy `src/web/index.html` → `dist/web-static/index.html` in build script
- [ ] **7.8.5** Add `ha-web` bin entry to `package.json` pointing to `dist/web.cjs`
- [ ] **7.8.6** Test full build: `npm run build` succeeds, `node dist/web.cjs` starts, browser
  chat works end-to-end

### Phase 7.9 — Compliance: Audit Log for Web Sessions

**Goal:** Web sessions write to the same audit log as CLI sessions (PHI compliance).

- [ ] **7.9.1** Confirm `complianceHooks.ts` registration is called from `engineFactory.ts`
  (not from CLI-specific code) — if not, move it there
- [ ] **7.9.2** Confirm audit logger writes session_id that identifies web vs CLI sessions
  (prefix: `web-` vs `cli-`) for audit trail clarity
- [ ] **7.9.3** Confirm PHI scanner PreToolUse hook fires for web sessions identically to CLI
- [ ] **7.9.4** Manual test: run a patient query in web UI, verify audit JSONL entry written

---

## What v0.2.0 Is and Is Not

### Is
- Browser-based chat UI sharing 100% of the CLI agent loop
- All 7 MCP servers accessible from the browser (auto-discovered)
- All skills and slash commands available with autocomplete
- Interactive permission prompts (safe mode — user approves dangerous tools)
- Multi-turn session continuity
- PHI compliance (same audit log, same PHI scanner as CLI)
- Local-first (web server runs on the user's machine, no cloud)

### Is Not
- A hosted/cloud service
- Multi-user (local single-user only, same as v0.1.0)
- A mobile app
- EHR integrated
- A replacement for the CLI (both are maintained, share same core)

---

## Phase Summary

| Phase | Work | Status |
|-------|------|--------|
| 0 — Strip & Harden | Remove telemetry, OAuth, Anthropic deps | ✅ Done |
| 1 — Compliance Layer | PHI guardrail, audit log | ✅ Done |
| 2 — Clinical MCP Servers | 7 servers, all free APIs | ✅ Done |
| 3 — Clinical Skills | 4 skill workflows | ✅ Done |
| 4 — Session Stability | Cross-day resume, parentUuid repair | ✅ Done |
| 5 — Patient Summary | FHIR-aligned schema v1 | ✅ Done |
| 6 — Restorable Features | Session naming, rewind, away summary, team review | ✅ Done |
| 7 — Web UI | Shared engine factory, Hono SSE server, React frontend | 🔲 In progress |

### Phase 7 Sub-tasks

| Sub-phase | Work | Status |
|-----------|------|--------|
| 7.1 — Shared Engine Factory | Extract init from main.tsx | 🔲 Todo |
| 7.2 — Hono Web Server | SSE API, session store, permission interception | 🔲 Todo |
| 7.3 — Frontend Core | React shell, SSE consumer, streaming text | 🔲 Todo |
| 7.4 — Tool Blocks | Collapsible inline tool use display | 🔲 Todo |
| 7.5 — Command Input | Slash autocomplete, sidebar skills + MCP status | 🔲 Todo |
| 7.6 — Permission Modal | Interactive approve/deny dialog | 🔲 Todo |
| 7.7 — Session Management | Multi-turn, localStorage, expiry handling | 🔲 Todo |
| 7.8 — Build Pipeline | Extend build.mjs, ha-web bin entry | 🔲 Todo |
| 7.9 — Compliance Audit | Confirm audit log + PHI scanner cover web sessions | 🔲 Todo |
