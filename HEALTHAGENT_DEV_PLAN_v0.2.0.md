# HealthAgent v0.2.0 — Development Plan

**Base:** HealthAgent v0.1.0 (Claude Code v2.1.88 source)
**Goal:** Web UI that shares 100% of the CLI core — same agent loop, same MCP servers, same skills
**Target:** Same individual clinicians and researchers as v0.1.0, now with browser access
**Status:** ✅ Complete — shipped across commits 6fae5aa → e5e5d11

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

## Architecture: What Was Actually Built

```
cli.tsx  → main.tsx        → QueryEngine → React/Ink → terminal
web.ts   → engineFactory   → QueryEngine → Hono SSE  → browser
                ↑
         src/shared/engineFactory.ts  (shared init layer)
```

### Deployment Model

```
Browser → localhost:3000 → local web.ts server → QueryEngine → local MCP servers
                                                              ↓
                                                     ~/.healthagent/
                                                     ├── patients/
                                                     ├── sessions/
                                                     └── audit/
```

Local-first. The web server runs on the user's machine. No patient data leaves the workstation.

---

## Files Created / Modified

```
src/
├── shared/
│   └── engineFactory.ts         ✅ created — shared init, EngineSession, WebCanUseTool
│
├── entrypoints/
│   └── web.ts                   ✅ created — Hono server, SSE, session store, compliance hooks
│
└── web/
    ├── index.html               ✅ created — SPA shell, light theme CSS, markdown styles
    ├── app.tsx                  ✅ created — full React app, sidebar, chat, palette, modals
    ├── types.ts                 ✅ created — ChatMsg, StoredSession, ControlRequest, MetaResponse
    └── components/
        ├── ChatMessage.tsx      ✅ created — user/assistant/tool message bubbles
        └── StreamingText.tsx    ✅ created — streaming cursor + marked.js markdown render

scripts/build.mjs                ✅ modified — Phase 5 (web server), Phase 6 (frontend bundle)
package.json                     ✅ modified — react-dom dep, ha-web bin entry
src/constants/prompts.ts         ✅ modified — hardcoded Verity identity (removed Claude fallback)
src/constants/system.ts          ✅ modified — hardcoded HEALTHAGENT_PREFIX
src/setup.ts                     ✅ modified — added HEALTHAGENT_WEB to compliance hook gate
src/utils/permissions/filesystem.ts  ✅ modified — "Claude requested" → "Verity requested" (11x)
src/utils/permissions/permissions.ts ✅ modified — same rename (1x)
src/tools/WebFetchTool/WebFetchTool.ts ✅ modified — same rename (2x)
```

---

## API Design

| Method | Route | Purpose |
|--------|-------|---------|
| `POST` | `/api/chat` | Send a message; creates or continues a session |
| `GET`  | `/api/stream/:sessionId` | SSE stream of SDKMessage NDJSON until turn complete |
| `POST` | `/api/control/:sessionId` | Browser replies to permission prompt (approve/deny) |
| `GET`  | `/api/meta` | Returns commands + MCP tools + MCP server status |
| `GET`  | `/*` | Serve `dist/web-static/` (index.html + app.js) |

---

## Frontend Features Shipped

| Feature | Implementation |
|---------|---------------|
| Chat history sidebar | localStorage (`verity_sessions`), grouped Today / Yesterday / Last 7 days / Older |
| New chat | Clears state, server assigns fresh session UUID |
| Session title | First 52 chars of first user message |
| Delete session | Hover reveals ✕ button, removes from localStorage |
| Welcome screen | Logo + 6 quick-action cards (only shown if skill is loaded) |
| Quick action chips | Shown above input during active chat; map to skill slash commands |
| Slash command palette | Floating overlay on `/`, searchable, shows name + description |
| Streaming text | Token-by-token with blinking cursor; renders markdown when done |
| Tool use blocks | Collapsible cards with spinner → "✓ Done", expandable input/result |
| Permission modal | Deny / Allow Once / Always Allow; blur backdrop |
| Settings modal | MCP server status badges + tool counts, skills/commands tag lists |
| Medical disclaimer | Footer below input on every turn |

---

## Key Bugs Fixed During Development

| Bug | Root Cause | Fix |
|----|-----------|-----|
| Identity answered "Claude" not "Verity" | `process.argv[1]` is `web.cjs` not `ha`; `isHealthAgent` checks missed web path | Set `HEALTHAGENT_WEB=1` in web.ts; added to all identity checks |
| Duplicate session on first message | Local UUID written before server responded; server assigns its own UUID | Removed optimistic localStorage write; persist only after `backendSid` received |
| Permission messages said "Claude requested" | Hardcoded strings in filesystem.ts, permissions.ts, WebFetchTool.ts | Replaced all 14 occurrences with "Verity requested" |
| Audit log not firing on web | `setup.ts` (where hooks register) only called from CLI `main.tsx` | Call `registerComplianceHooks()` directly in web.ts `main()` |

---

## Web vs CLI: Known Limitations

### Session ID in Audit Log (Best-Effort)

**Problem:** `getSessionId()` reads from a process-global (`STATE.sessionId` in bootstrap/state.ts). With multiple concurrent web sessions, the last request to call `switchSession()` sets the global — so audit entries from concurrent sessions may be tagged with the wrong session UUID.

**Current behaviour:** `switchSession(sessionId)` is called at the start of each `GET /api/stream/:sessionId` request. For single-user usage (one active session at a time), audit entries are correctly tagged. For concurrent users, session IDs in the audit log are best-effort.

**Proper fix (not yet done):** Use Node.js `AsyncLocalStorage` to propagate the web session ID through the async call chain without touching the process global.

**PHI blocking is unaffected** — it fires in `PreToolUse` hooks regardless of session ID correctness.

### Chat History is Local to the Browser

CLI saves sessions as JSONL files under `~/.healthagent/sessions/` — persistent, portable, resumable across any terminal.

Web saves chat history in the **browser's localStorage** — visible only in that browser on that machine. Clearing browser data deletes history. No cross-device access.

If the web server restarts, the server-side in-memory `sessions` Map is lost (2-hour TTL). The browser can reload history from localStorage for display, but continuing an interrupted turn requires a new turn.

### No User Identity / Multi-User

The web server has no authentication. All browser clients connecting to the same server share:
- The same MCP connections
- The same tool pool
- The same `alwaysAllowRules` (Always Allow decisions are session-scoped but not user-scoped)

For single-user local deployment (one person, their own machine), this is fine. For a shared server, user A can see no isolation from user B.

**Proper fix:** Add a session token (even a simple bearer token in `.env`) to isolate users. Full multi-user requires per-user auth and per-user state.

### CLI Has Full Session Resume; Web Does Not

CLI sessions are stored as JSONL transcripts and can be resumed cross-day with `--resume`. The full message history is replayed into the model context.

Web sessions are in-memory on the server (2hr TTL). The browser shows chat history from localStorage, but this is UI-only — if the server session expires, continuing a conversation starts a fresh context (the model does not see prior turns). The UI does not warn the user when this happens.

### Always Allow Rules Are Not Persistent on Web

CLI writes `alwaysAllow` rules to `~/.claude/settings.json` — they survive restarts.

Web writes them only to the in-memory `AppState` for the current server process — cleared on restart.

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
| 7 — Web UI | Shared engine factory, Hono SSE server, React frontend | ✅ Done |

### Phase 7 Sub-tasks

| Sub-phase | Work | Status | Notes |
|-----------|------|--------|-------|
| 7.1 — Shared Engine Factory | Extract init from main.tsx | ✅ Done | `src/shared/engineFactory.ts` |
| 7.2 — Hono Web Server | SSE API, session store, permission interception | ✅ Done | `src/entrypoints/web.ts` |
| 7.3 — Frontend Core | React shell, SSE consumer, streaming text, modern UI | ✅ Done | Full redesign incl. sidebar, palette, settings |
| 7.4 — Tool Blocks | Collapsible inline tool use display | ✅ Done | Folded into 7.3 redesign |
| 7.5 — Command Input | Slash autocomplete, sidebar skills + MCP status | ✅ Done | Folded into 7.3 redesign |
| 7.6 — Permission Modal | Interactive approve/deny dialog | ✅ Done | Folded into 7.3 redesign |
| 7.7 — Session Management | Multi-turn, localStorage, expiry handling | ✅ Done | localStorage-based; see limitations above |
| 7.8 — Build Pipeline | Extend build.mjs, ha-web bin entry | ✅ Done | Phases 5 + 6 in build.mjs |
| 7.9 — Compliance Audit | Confirm audit log + PHI scanner cover web sessions | ✅ Done | Hooks registered in web.ts; session ID best-effort |

---

## What v0.2.0 Is and Is Not

### Is
- Browser-based chat UI sharing 100% of the CLI agent loop
- All 7 MCP servers accessible from the browser (auto-discovered)
- All skills and slash commands available with autocomplete + quick-action cards
- Interactive permission prompts (safe mode — user approves dangerous tools)
- Multi-turn session continuity (within one server session)
- PHI compliance (same audit log, same PHI scanner as CLI)
- Local-first (web server runs on the user's machine, no cloud)
- Chat history sidebar (localStorage, survives page refresh)

### Is Not
- A hosted/cloud service
- Multi-user (no auth, no user isolation — local single-user only)
- Cross-device (history in localStorage, not synced)
- Full session resume (server memory lost on restart; no JSONL transcript on web)
- A replacement for the CLI (both maintained, share same core)
