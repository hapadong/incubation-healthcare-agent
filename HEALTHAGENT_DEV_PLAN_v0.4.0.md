# HealthAgent v0.4.0 — Development Plan

**Base:** HealthAgent v0.3.0
**Goal:** Multi-user centralized deployment — authentication, storage abstraction, per-user
isolation, scalable MCP layer, horizontal app server scaling
**Status:** Planning

---

## Problem Statement

v0.1.0–v0.3.0 are local-first, single-user tools. Every architectural decision — in-memory
sessions, filesystem storage, stdio MCP processes, no auth — was correct for that context.

For a shared clinical environment (hospital department, research group, SaaS), the same
assumptions break:

- A clinician at one workstation cannot access their history from another machine
- Two users sharing a server corrupt each other's session state and audit logs
- MCP stdio child processes cannot be shared or pooled across users
- No auth means any request can read or write any patient data
- A single app server process is a single point of failure

v0.4.0 addresses each of these in a deliberate sequence — auth first, storage abstraction second,
infrastructure third — so the system is always in a shippable state between sub-phases.

---

## Guiding Principles

**Never break the local-first path.** CLI users running `ha` on their own machine must continue
to work exactly as in v0.3.0. All new infrastructure is optional — the system detects whether
it is running in local mode or centralized mode and selects the appropriate implementations.

**Interfaces before implementations.** Every storage and connection concern gets an interface
first, a local implementation second, and a production implementation third. No migration is
needed — just swap the implementation at startup.

**Incremental MCP migration.** Do not rewrite all MCP servers at once. Migrate stateless public
API servers to HTTP transport one at a time. Stateful user-scoped servers (patients) move to
per-user isolation last.

---

## Architecture: Local vs Centralized Mode

### Local mode (v0.1.0–v0.3.0 behaviour, unchanged)

```
ha / ha-web / ha run
      |
  No HEALTHAGENT_DB_URL set
      |
  LocalFileSessionStore     (~/.healthagent/sessions/)
  LocalFilePatientStore     (~/.healthagent/patients/)
  LocalFileAuditStore       (~/.healthagent/audit/)
  LocalSettingsStore        (~/.claude/settings.json)
  StdioMcpConnectionPool    (child processes, per process)
  InMemoryWebSessionStore   (Map<string, WebSession>)
```

### Centralized mode (v0.4.0, activated by env vars)

```
ha-web (multi-instance behind load balancer)
      |
  HEALTHAGENT_DB_URL + HEALTHAGENT_REDIS_URL set
      |
  PostgresSessionStore      (pg: sessions table)
  S3PatientStore            (s3: per-user prefix)
  PostgresAuditStore        (pg: audit_entries table)
  PostgresSettingsStore     (pg: user_settings table)
  RedisWebSessionStore      (redis: per-request SSE pub/sub)
  HttpMcpConnectionPool     (HTTP transport, shared)
```

The mode is selected once at startup in `engineFactory.ts` — nothing in the agent loop,
tool system, or MCP skill layer changes.

---

## New Abstractions

### Storage interfaces

```typescript
// src/storage/interfaces.ts

interface ISessionStore {
  get(sessionId: string): Promise<StoredSession | null>
  set(sessionId: string, session: StoredSession): Promise<void>
  delete(sessionId: string): Promise<void>
  listByUser(userId: string): Promise<StoredSession[]>
}

interface IPatientStore {
  get(userId: string, patientId: string): Promise<Patient | null>
  save(userId: string, patient: Patient): Promise<void>
  list(userId: string): Promise<PatientSummary[]>
  delete(userId: string, patientId: string): Promise<void>
}

interface IAuditStore {
  append(entry: AuditEntry): Promise<void>
  query(userId: string, filters: AuditQueryFilters): Promise<AuditEntry[]>
}

interface ISettingsStore {
  get(userId: string): Promise<UserSettings>
  set(userId: string, settings: Partial<UserSettings>): Promise<void>
}

interface IWebSessionStore {
  // In-process web sessions (SSE, pending controls, abort signals)
  create(sessionId: string, session: WebSession): void
  get(sessionId: string): WebSession | undefined
  delete(sessionId: string): void
  publish(sessionId: string, event: SseEvent): Promise<void>   // for Redis pub/sub
  subscribe(sessionId: string, handler: (e: SseEvent) => void): () => void
}
```

### MCP connection interface

```typescript
// src/services/mcp/interfaces.ts

interface IMcpConnectionPool {
  // Returns tools + commands for all configured servers
  getToolsAndCommands(): Promise<{ tools: Tools; commands: Command[] }>
  // Dispose all connections
  close(): Promise<void>
}

// Two implementations:
// StdioMcpConnectionPool  — current behaviour (child processes, per process)
// HttpMcpConnectionPool   — HTTP/SSE transport (shared, reconnectable)
```

---

## Database Schema (PostgreSQL)

```sql
-- Users
CREATE TABLE users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,          -- bcrypt
  display_name TEXT,
  role        TEXT DEFAULT 'user',      -- user | admin
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  last_login  TIMESTAMPTZ
);

-- Chat sessions (metadata only; messages stored in session_messages)
CREATE TABLE chat_sessions (
  id          UUID PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Chat messages
CREATE TABLE session_messages (
  id          BIGSERIAL PRIMARY KEY,
  session_id  UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,           -- user | assistant | tool
  content     TEXT,
  tool_name   TEXT,
  tool_input  JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Per-user settings (tool permissions, model selection, etc.)
CREATE TABLE user_settings (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings    JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Audit log
CREATE TABLE audit_entries (
  id              BIGSERIAL PRIMARY KEY,
  timestamp       TIMESTAMPTZ NOT NULL,
  user_id         UUID REFERENCES users(id),
  session_id      UUID,
  tool_name       TEXT NOT NULL,
  external        BOOLEAN NOT NULL,
  input_hash      TEXT NOT NULL,
  phi_blocked     BOOLEAN NOT NULL,
  phi_categories  TEXT[],
  outcome         TEXT NOT NULL,
  source          TEXT DEFAULT 'web'   -- web | cli | workflow
);

-- Workflow runs (v0.3.0 runner, centralized manifest)
CREATE TABLE workflow_runs (
  id          UUID PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id),
  workflow    TEXT NOT NULL,
  status      TEXT NOT NULL,
  started_at  TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  manifest    JSONB
);

-- Indexes
CREATE INDEX ON chat_sessions(user_id, updated_at DESC);
CREATE INDEX ON session_messages(session_id, created_at);
CREATE INDEX ON audit_entries(user_id, timestamp DESC);
CREATE INDEX ON audit_entries(session_id);
```

---

## Auth Design

### Token model

- **Access token**: short-lived JWT (15 min), signed with `HEALTHAGENT_JWT_SECRET`
- **Refresh token**: long-lived (30 days), stored as httpOnly cookie, rotated on use
- No OAuth in v0.4.0 — simple email/password. OAuth (SSO/SAML for hospital IdP) is v0.5.0.

### New API routes

```
POST /api/auth/register      { email, password, displayName }  → { userId }
POST /api/auth/login         { email, password }               → { accessToken } + sets refresh cookie
POST /api/auth/refresh                                          → { accessToken }
POST /api/auth/logout                                          → clears refresh cookie
GET  /api/auth/me                                              → { userId, email, displayName, role }
```

### Middleware

```typescript
// All /api/* routes except /api/auth/* require Authorization: Bearer <accessToken>
// Middleware extracts userId from JWT and attaches to request context
// 401 if missing/expired, 403 if insufficient role
```

---

## MCP Migration Strategy

### The problem restated

Current MCP servers spawn as stdio child processes. One process can host one pool.
For N users on a shared server, options are:

| Option | Description | Cost |
|--------|-------------|------|
| A. One pool per user session | Spawn fresh MCP processes per user | 7 processes × N users = unsustainable |
| B. Shared stdio pool | All users share one pool | No user isolation possible for stateful tools |
| C. HTTP/SSE transport | MCP over HTTP, connections reconnectable | Correct, requires rewriting MCP servers |
| D. MCP proxy sidecar | A proxy process per user in front of stdio servers | Complex, extra latency |

**Decision: Option C for stateless servers, Option A for user-scoped servers.**

### Classification

| Server | Type | v0.4.0 strategy |
|--------|------|----------------|
| pubmed | Stateless, public API | Migrate to HTTP transport, shared pool |
| trials | Stateless, public API | Migrate to HTTP transport, shared pool |
| drugs | Stateless, public API | Migrate to HTTP transport, shared pool |
| coding | Stateless, public API | Migrate to HTTP transport, shared pool |
| guidelines | Stateless, public API | Migrate to HTTP transport, shared pool |
| mimic | Read-only DB queries | Migrate to HTTP transport, shared pool |
| patients | User-scoped data store | Per-user instance at session start |

### HTTP transport MCP architecture

```
App Server
    |
HttpMcpConnectionPool (singleton, shared across all requests)
    |
HTTP/SSE → MCP Server process (long-running, stateless)
              pubmed-mcp  :4001
              trials-mcp  :4002
              drugs-mcp   :4003
              coding-mcp  :4004
              guidelines-mcp :4005
              mimic-mcp   :4006
```

The MCP servers run as separate long-running processes (or containers), reachable over HTTP.
The app server connects once at startup and reuses the connection pool for all users.
The `patients` MCP server runs per-user session (spawned on demand, short-lived).

---

## SSE in Multi-Server Deployments

SSE streams are bound to a single HTTP connection on a single app server instance. With
horizontal scaling, `POST /api/chat` and `GET /api/stream` may land on different instances.

### Solution: Redis pub/sub

```
User POST /api/chat → Server A
User GET /api/stream → Server B  ← connection lives here

Server A:  ask() produces events
               → publish to Redis channel "session:{sessionId}"
Server B:  subscribed to "session:{sessionId}"
               → forward events to the user's SSE connection
```

`RedisWebSessionStore` implements the `IWebSessionStore` interface. In local mode,
`InMemoryWebSessionStore` uses a simple EventEmitter — no Redis needed.

---

## Environment Configuration

```bash
# ── Mode detection ──────────────────────────────────────────────────────────
# If HEALTHAGENT_DB_URL is set, centralized mode activates.
# If unset, local-first mode (v0.3.0 behaviour) is used.
HEALTHAGENT_DB_URL=postgres://user:pass@host:5432/healthagent

# ── Redis (required for centralized mode) ───────────────────────────────────
HEALTHAGENT_REDIS_URL=redis://host:6379

# ── Object store for patient files ──────────────────────────────────────────
HEALTHAGENT_S3_BUCKET=healthagent-patients
HEALTHAGENT_S3_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
# OR for MinIO (self-hosted):
HEALTHAGENT_S3_ENDPOINT=http://minio:9000

# ── Auth ────────────────────────────────────────────────────────────────────
HEALTHAGENT_JWT_SECRET=<random 256-bit secret>
HEALTHAGENT_JWT_EXPIRY=15m
HEALTHAGENT_REFRESH_EXPIRY=30d

# ── MCP HTTP transport ──────────────────────────────────────────────────────
HEALTHAGENT_MCP_PUBMED_URL=http://mcp-pubmed:4001
HEALTHAGENT_MCP_TRIALS_URL=http://mcp-trials:4002
HEALTHAGENT_MCP_DRUGS_URL=http://mcp-drugs:4003
HEALTHAGENT_MCP_CODING_URL=http://mcp-coding:4004
HEALTHAGENT_MCP_GUIDELINES_URL=http://mcp-guidelines:4005
HEALTHAGENT_MCP_MIMIC_URL=http://mcp-mimic:4006
# patients MCP is per-user, spawned locally — no URL

# ── Rate limiting (per user) ─────────────────────────────────────────────────
HEALTHAGENT_USER_RPM=20
HEALTHAGENT_USER_TPM=80000
```

---

## Deployment Topology

```
                         ┌──────────────────┐
                         │   Load Balancer  │
                         │  (nginx / ALB)   │
                         └────────┬─────────┘
                    ┌─────────────┼─────────────┐
                    ↓             ↓             ↓
             ┌──────────┐ ┌──────────┐ ┌──────────┐
             │  ha-web  │ │  ha-web  │ │  ha-web  │
             │ instance │ │ instance │ │ instance │
             └────┬─────┘ └────┬─────┘ └────┬─────┘
                  └────────────┼─────────────┘
                               ↓
          ┌────────────────────────────────────────┐
          │            Shared Infrastructure        │
          │                                        │
          │  PostgreSQL          Redis              │
          │  · users             · web sessions     │
          │  · chat history      · SSE pub/sub      │
          │  · audit log                           │
          │  · settings                            │
          │                                        │
          │  S3 / MinIO                            │
          │  · patient records (per-user prefix)   │
          │                                        │
          │  MCP Services (HTTP transport)         │
          │  · pubmed :4001   · coding  :4004      │
          │  · trials :4002   · guide   :4005      │
          │  · drugs  :4003   · mimic   :4006      │
          └────────────────────────────────────────┘
```

---

## New Files

```
src/
├── auth/
│   ├── jwt.ts              JWT sign/verify, access + refresh token logic
│   ├── middleware.ts        Auth middleware for Hono routes
│   ├── handlers.ts          register, login, refresh, logout, me
│   └── password.ts          bcrypt hash/verify
│
├── storage/
│   ├── interfaces.ts        ISessionStore, IPatientStore, IAuditStore, ISettingsStore
│   ├── factory.ts           selectImplementations() based on env vars
│   ├── local/
│   │   ├── fileSessionStore.ts
│   │   ├── filePatientStore.ts
│   │   ├── fileAuditStore.ts
│   │   └── fileSettingsStore.ts
│   └── postgres/
│       ├── pgSessionStore.ts
│       ├── pgPatientStore.ts
│       ├── pgAuditStore.ts
│       └── pgSettingsStore.ts
│
├── webSession/
│   ├── interfaces.ts        IWebSessionStore
│   ├── inMemoryStore.ts     current Map-based impl (local mode)
│   └── redisStore.ts        Redis pub/sub impl (centralized mode)
│
├── services/mcp/
│   ├── interfaces.ts        IMcpConnectionPool
│   ├── stdioPool.ts         current child-process impl (renamed from client.ts)
│   └── httpPool.ts          HTTP/SSE transport pool (new)
│
└── db/
    ├── client.ts            postgres connection pool (pg / postgres.js)
    ├── migrations/
    │   └── 001_initial.sql  schema from above
    └── redis.ts             Redis client singleton

src/entrypoints/web.ts       Add auth routes, inject userId into all handlers
src/shared/engineFactory.ts  Accept userId, select storage implementations
```

Files **not** changed: `QueryEngine.ts`, all tool implementations, all skill files,
`complianceHooks.ts`, `auditLogger.ts` (interface wraps it), workflow runner.

---

## Detailed Task List

### Phase 9.1 — Storage Interfaces & Local Implementations

**Goal:** Wrap all current filesystem/memory access behind interfaces. Zero behaviour change —
local implementations reproduce exactly what the code does today.

- [ ] **9.1.1** Audit all direct filesystem calls in the codebase:
  `grep -r "readFileSync\|writeFileSync\|appendFileSync\|mkdirSync\|homedir" src/`
  Map each to the interface it belongs to
- [ ] **9.1.2** Write `src/storage/interfaces.ts` — the 4 storage interfaces
- [ ] **9.1.3** Write `src/storage/local/fileSessionStore.ts` — wraps current `~/.healthagent/sessions/`
- [ ] **9.1.4** Write `src/storage/local/filePatientStore.ts` — wraps current `~/.healthagent/patients/`
- [ ] **9.1.5** Write `src/storage/local/fileAuditStore.ts` — wraps `auditLogger.ts` append
- [ ] **9.1.6** Write `src/storage/local/fileSettingsStore.ts` — wraps `~/.claude/settings.json`
- [ ] **9.1.7** Write `src/storage/factory.ts` — returns local implementations when `HEALTHAGENT_DB_URL` unset
- [ ] **9.1.8** Thread storage instances through `engineFactory.ts` instead of direct file access
- [ ] **9.1.9** Regression test: CLI + web behave identically to v0.3.0 after refactor

### Phase 9.2 — Web Session Store Interface

**Goal:** Isolate the in-memory web session Map behind an interface, enabling Redis swap later.

- [ ] **9.2.1** Write `src/webSession/interfaces.ts` — `IWebSessionStore` with pub/sub methods
- [ ] **9.2.2** Write `src/webSession/inMemoryStore.ts` — current Map + EventEmitter impl
- [ ] **9.2.3** Refactor `src/entrypoints/web.ts` to use `IWebSessionStore` instead of bare `Map`
- [ ] **9.2.4** Test: SSE stream still works correctly after refactor

### Phase 9.3 — Database Setup & Migrations

**Goal:** PostgreSQL schema and client, with a migration runner.

- [ ] **9.3.1** Add `pg` (or `postgres`) to dependencies; add `HEALTHAGENT_DB_URL` to env docs
- [ ] **9.3.2** Write `src/db/client.ts` — connection pool with graceful shutdown
- [ ] **9.3.3** Write `src/db/migrations/001_initial.sql` — full schema from above
- [ ] **9.3.4** Add migration runner: `ha db migrate` CLI command (or auto-runs at startup)
- [ ] **9.3.5** Add `ha db status` to show applied migrations
- [ ] **9.3.6** Test: run migrations against a local Postgres, verify all tables created

### Phase 9.4 — Auth Layer

**Goal:** JWT-based authentication with register/login/refresh/logout.

- [ ] **9.4.1** Add `bcryptjs` and `jsonwebtoken` dependencies
- [ ] **9.4.2** Write `src/auth/password.ts` — hash and verify
- [ ] **9.4.3** Write `src/auth/jwt.ts` — sign/verify access + refresh tokens
- [ ] **9.4.4** Write `src/auth/handlers.ts` — register, login, refresh, logout, me routes
- [ ] **9.4.5** Write `src/auth/middleware.ts` — extract userId from Bearer token, 401 on failure
- [ ] **9.4.6** Add auth routes to `web.ts`; apply middleware to all `/api/*` except `/api/auth/*`
- [ ] **9.4.7** Add minimal login UI to `src/web/app.tsx` — email/password form shown when
  unauthenticated; stores access token in memory, refresh token in httpOnly cookie
- [ ] **9.4.8** Test: register user, login, access protected route, token expiry + refresh flow

### Phase 9.5 — PostgreSQL Storage Implementations

**Goal:** Production storage implementations behind the interfaces from 9.1.

- [ ] **9.5.1** Write `src/storage/postgres/pgSessionStore.ts` — chat_sessions + session_messages
- [ ] **9.5.2** Write `src/storage/postgres/pgAuditStore.ts` — audit_entries table
- [ ] **9.5.3** Write `src/storage/postgres/pgSettingsStore.ts` — user_settings table
- [ ] **9.5.4** Update `src/storage/factory.ts` — select Postgres implementations when `HEALTHAGENT_DB_URL` set
- [ ] **9.5.5** Thread `userId` through all storage calls (session history, audit entries, settings)
- [ ] **9.5.6** Update `src/web/app.tsx` — chat history sidebar reads from `/api/sessions`
  (new route backed by `ISessionStore`) instead of localStorage
- [ ] **9.5.7** Test: two users, verify sessions are isolated (user A cannot see user B's history)
- [ ] **9.5.8** Test: audit entries tagged with correct userId

### Phase 9.6 — S3 Patient Store

**Goal:** Per-user patient records in object storage.

- [ ] **9.6.1** Add `@aws-sdk/client-s3` — already in deps (check); add MinIO dev setup to docs
- [ ] **9.6.2** Write `src/storage/s3/s3PatientStore.ts`:
  - Key pattern: `patients/{userId}/{patientId}.json`
  - Implements `IPatientStore`
  - Presigned URLs for large file downloads if needed
- [ ] **9.6.3** Update factory to select S3 implementation when `HEALTHAGENT_S3_BUCKET` set
- [ ] **9.6.4** Test: save patient for user A, verify user B cannot access it (key isolation)
- [ ] **9.6.5** Test: local mode still uses filesystem (no regression)

### Phase 9.7 — Redis Web Session Store

**Goal:** SSE pub/sub across multiple app server instances.

- [ ] **9.7.1** Add `ioredis` dependency
- [ ] **9.7.2** Write `src/db/redis.ts` — Redis client singleton with reconnect handling
- [ ] **9.7.3** Write `src/webSession/redisStore.ts`:
  - Session metadata in Redis hash (`session:{id}`)
  - SSE events published to Redis channel (`sse:{sessionId}`)
  - App server subscribes at stream-open, unsubscribes on stream-close
  - TTL aligned with `SESSION_TTL_MS`
- [ ] **9.7.4** Update factory to select Redis implementation when `HEALTHAGENT_REDIS_URL` set
- [ ] **9.7.5** Test: simulate two-instance setup — POST to instance A, SSE on instance B,
  verify events arrive

### Phase 9.8 — MCP HTTP Transport

**Goal:** Migrate stateless MCP servers to HTTP/SSE transport, shareable across users.

- [ ] **9.8.1** Write `src/services/mcp/interfaces.ts` — `IMcpConnectionPool`
- [ ] **9.8.2** Rename current `src/services/mcp/client.ts` → `stdioPool.ts`;
  implement `IMcpConnectionPool`
- [ ] **9.8.3** Write `src/services/mcp/httpPool.ts` — connects via HTTP/SSE MCP transport;
  reads server URLs from env vars
- [ ] **9.8.4** Migrate MCP servers one by one to HTTP transport (add HTTP server wrapper
  to each, keep stdio as fallback):
  - [ ] pubmed MCP
  - [ ] trials MCP
  - [ ] drugs MCP
  - [ ] coding MCP
  - [ ] guidelines MCP
  - [ ] mimic MCP
- [ ] **9.8.5** `patients` MCP: keep stdio, spawn per-user session, isolated by userId prefix
- [ ] **9.8.6** Update `engineFactory.ts` — select `HttpMcpConnectionPool` or `StdioMcpConnectionPool`
  based on env; HTTP pool is singleton shared across all sessions
- [ ] **9.8.7** Test: two concurrent users using pubmed MCP simultaneously, verify no cross-user
  data bleed

### Phase 9.9 — Per-User Rate Limiting

**Goal:** Prevent one user from exhausting API quota for all users.

- [ ] **9.9.1** Port v0.3.0 token-bucket rate limiter to per-user scope (keyed by userId)
- [ ] **9.9.2** Store rate limit state in Redis (survives restarts, works across instances)
- [ ] **9.9.3** Return `HTTP 429` with `Retry-After` header when user exceeds limit
- [ ] **9.9.4** Admin endpoint: `GET /api/admin/users` — rate limit usage per user
- [ ] **9.9.5** Test: single user hammering requests is throttled; other users unaffected

### Phase 9.10 — Docker Compose & Deployment

**Goal:** One-command local centralized deployment for testing; deployment docs for production.

- [ ] **9.10.1** Write `docker-compose.yml`:
  ```yaml
  services:
    web:      ha-web (2 instances for testing multi-instance SSE)
    postgres: postgres:16
    redis:    redis:7
    minio:    minio/minio (S3-compatible local)
    pubmed-mcp, trials-mcp, drugs-mcp, coding-mcp, guidelines-mcp, mimic-mcp
  ```
- [ ] **9.10.2** Write `Dockerfile` for `ha-web`
- [ ] **9.10.3** Write `Dockerfile` for each HTTP-transport MCP server
- [ ] **9.10.4** Write `docker-compose.local.yml` (local mode, no Postgres/Redis — for dev)
- [ ] **9.10.5** Write `DEPLOYMENT.md`: env vars reference, scaling guidance, backup strategy
- [ ] **9.10.6** End-to-end test: `docker compose up`, register 2 users, verify full isolation

---

## Migration Path for Existing Users

Existing v0.3.0 local users are unaffected — local mode is the default when `HEALTHAGENT_DB_URL`
is not set. For users who want to migrate to centralized mode:

```bash
# 1. Start infrastructure
docker compose up postgres redis minio

# 2. Run DB migrations
ha db migrate

# 3. Import existing local history (optional migration utility)
ha migrate-local --user your@email.com

# 4. Set env vars and restart web server
HEALTHAGENT_DB_URL=postgres://... ha-web
```

The `ha migrate-local` utility reads `~/.healthagent/` and imports sessions, patients, and
audit entries into the database under the specified userId.

---

## Known Challenges & Mitigations

| Challenge | Severity | Mitigation |
|---|---|---|
| MCP stdio → HTTP rewrite effort | High | Migrate one server at a time; stdio fallback always available |
| SSE across app instances without Redis | High | Sticky sessions as interim (nginx `ip_hash`); Redis pub/sub is correct long-term |
| Patient data residency / HIPAA | High | S3 server-side encryption; audit log for all access; documented in `DEPLOYMENT.md` |
| bcrypt cost under load | Medium | Async bcrypt; consider argon2 for v0.5.0 |
| PostgreSQL connection pool exhaustion | Medium | `pg` pool capped at 20; PgBouncer for high concurrency |
| Refresh token rotation race (concurrent requests) | Medium | DB-level locking on refresh token use; invalidate on first use |
| localStorage → DB migration for existing users | Low | One-time migration script; localStorage kept as read-only fallback during transition |

---

## What v0.4.0 Is and Is Not

### Is
- Multi-user with per-user auth (email/password), data isolation, and audit trails
- Storage-abstracted: same interfaces, swappable backends (local filesystem ↔ Postgres/S3/Redis)
- Horizontally scalable web servers (stateless once Redis pub/sub is in place)
- Shared MCP connection pool for stateless servers (HTTP transport)
- Docker Compose deployment for self-hosted teams
- Fully backwards-compatible: local single-user mode unchanged

### Is Not
- SSO / SAML / hospital IdP integration (v0.5.0)
- FHIR resource output or EHR write-back (v0.5.0)
- Cloud-hosted SaaS (self-hosted only; operator deploys their own infrastructure)
- HIPAA Business Associate Agreement — operator responsibility; this plan provides the
  technical controls (encryption at rest, audit log, access isolation), not legal compliance
- Role-based access control beyond user/admin (v0.5.0)

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
| 8 — Workflow Runner | YAML pipelines, batch execution, structured output | 🔲 Planning |
| 9 — Multi-User | Auth, storage abstraction, MCP HTTP, horizontal scaling | 🔲 Planning |

### Phase 9 Sub-tasks

| Sub-phase | Work | Status |
|-----------|------|--------|
| 9.1 — Storage Interfaces | Wrap all FS/memory access; local implementations | 🔲 Todo |
| 9.2 — Web Session Interface | Isolate in-memory session Map | 🔲 Todo |
| 9.3 — Database Setup | PostgreSQL schema, migrations, client | 🔲 Todo |
| 9.4 — Auth Layer | JWT, register/login/refresh, middleware, login UI | 🔲 Todo |
| 9.5 — Postgres Storage | Session history, audit, settings per user | 🔲 Todo |
| 9.6 — S3 Patient Store | Per-user object storage with key isolation | 🔲 Todo |
| 9.7 — Redis Web Sessions | SSE pub/sub for multi-instance deployments | 🔲 Todo |
| 9.8 — MCP HTTP Transport | Migrate stateless MCPs; shared connection pool | 🔲 Todo |
| 9.9 — Per-User Rate Limiting | Redis-backed token bucket per userId | 🔲 Todo |
| 9.10 — Docker & Deployment | Compose, Dockerfiles, deployment docs | 🔲 Todo |
