# Task: Rewrite the provider's session and query core
**Date Started**: 2026-11-26
**Status**: Planned
**Baseline**: tag `port-baseline` (OMP 19.2 port with per-session state)

## Why

The bridge was built for one agent per process. One module-level session
(Claude Code session id + message cursor) served every caller: the main
agent, in-process subagents, `/btw` side requests and AskClaude. OMP 19.2
runs subagents in-process and adds side requests, so that design broke.

The review history of the 19.2 port (DevVig/omp-claude-bridge#17) showed the
pattern: about 12 real findings, nearly all of them bugs that were already on
upstream `main`. Each fix touched nearby code and the next review found more.
The fixes that guarded single lines made it worse; the fix that changed who
owns the state (`src/bridge-session.ts`) made it better.

**Lesson:** when the same kind of bug shows up twice in shared state, change
who owns the state. Don't add guards.

## What `port-baseline` already does

- `src/bridge-session.ts`: one `BridgeSession` per OMP provider `sessionId`,
  stored in `options.providerSessionState` under `claude-bridge:<sessionId>`.
  A module registry `bridgeSessions` (by `sessionId`) serves the hooks and
  AskClaude.
- `syncSession(session, …)` in `src/index.ts`: REUSE/REBUILD of the Claude
  Code session JSONL, per session.
- Each `QueryContext` records the session it owns (`ownedSession`, `null` for
  preserveSession helper queries). Tool-result, abort and error paths write
  only to that session.
- Deferred steers replay for reentrant queries too, against the query's own
  session. Abort targets whichever query is running (`runningQuery`).
- AskClaude always syncs its context before resuming.

## OMP 19.2 facts the design depends on

Verified in `node_modules/@oh-my-pi/pi-coding-agent/src/session/agent-session.ts`
unless noted.

- Every `AgentSession` owns a `providerSessionState: Map<string,
  ProviderSessionState>` and passes it with each provider request.
  `ProviderSessionState` is `{ close(): void; releaseSession?(id): void }`.
- OMP closes every entry on dispose, `freshSession()`, `resetSessionContext()`,
  `newSession()`, a switch to a different session, and a reload that changed
  the conversation. It does **not** close them on branch, tree navigation or
  compaction.
- The provider `sessionId` is `freshProviderSessionId ?? providerSessionId ??
  sessionManager.getSessionId()`. After `freshSession()` it differs from the
  session-file id.
- Side requests use the main agent's map with their own `sessionId`:
  `<id>:side:<snowflake>`, or `<id>:side:conversation:<key>` for multi-turn
  side conversations.
- `ExtensionContext` exposes neither the provider `sessionId` nor the map.
  Hooks and tools only see `ctx.sessionManager.getSessionId()`.
- In-process subagents load the same module instance as the parent.
  Worker-thread subagents get their own module instance (per a CodeRabbit
  review, citing `src/thread/subagent-worker.ts`; not re-checked).
- Other OMP providers key their state the same way (`antigravity-cli` uses
  `antigravity-acp:<account>:<sessionId>`).

## Known defects in `port-baseline`

- **Reentrancy is process-wide.** `ctx()` is one top-level `QueryContext`,
  and `isReentrant = ctx().activeQuery !== null`. A request from one session
  is treated as reentrant because another session is busy.
- **History is matched by counting messages.** The cursor is a message
  count. REUSE assumes "nothing new after the cursor" means "same history";
  the preserve path assumes "shorter context" means "helper request". Any
  history rewrite that no hook reports breaks this silently.
- **A same-`sessionId` helper with a longer context** (OMP advisors and
  maintenance requests can reuse the agent's `sessionId`) skips the preserve
  path and replaces the agent's session state on completion.
- **The orphaned tool-result path** (tool result, no active query) writes
  the cursor of whatever session `options` names.
- **AskClaude:**
  - It never advances the cursor, so the next provider turn rebuilds.
  - It looks up the session by session-file id, which misses the provider
    session after `freshSession()`.
  - It compares a message count from `buildSessionContext(getBranch())`
    with the provider's `context.messages` count, which come from different
    builders.
  - Entries created only by AskClaude live until main `session_shutdown`.
- **Hook invalidation is too broad.** Compact, tree and branch mark every
  live session for rebuild, because hooks can't tell which session is
  theirs.
- **Abort cleanup lives in four places** (`onAbort`, the abort branch after
  completion, `.catch`, `.finally`).
- **Steer replay output** goes into the same pi stream turn. Check how OMP
  renders continuation output after a tool-result turn.

## Rewrite goals

1. **One owner per OMP session.** A session object owns its Claude Code
   session id, its sync state, the running query, pending tool calls,
   queued tool results and deferred steers. There is no process-wide "active
   query" and no top-level context.
2. **Explicit request kinds.** Decide once per request whether it is a turn,
   a tool-result delivery, an orphaned result or a helper request, from data
   the request carries, not from global state.
3. **Detect divergence by content, not by count.** Store a fingerprint of the
   synced message prefix (per-message hashes or ids). REUSE when the stored
   prefix matches; otherwise REBUILD. This removes the preserve-path
   heuristic and most of the hook invalidation.
4. **One lifecycle.** Use OMP's `close()` for session end. Use one abort and
   cleanup path per query, so that continuations, abort and errors all go
   through it.
5. **Small, testable units.** Split `streamClaudeAgentSdk` (about 350 lines)
   into tool-result routing, the sync decision, SDK option building, the
   stream consumer and replay. Keep the sync decision and the request
   classification as pure functions.
6. **Fewer module globals.** Today they are `activeQueryContexts`, `_ctx`,
   `piUI`, `bridgeSessions`, `providerSettings`, `longContextSettings` and
   `askClaudeToolName`. Keep only real process-wide configuration.

## Keep

- `src/convert.ts`, `src/models.ts`, `src/config.ts`, `src/skills.ts`,
  `src/agents-md.ts`, `src/rate-limit.ts`, `src/askclaude-ui.ts`,
  `src/typebox-to-zod.ts`, `src/extract-tool-results.ts`,
  `src/session-verify.ts`.
- The comments that record Claude Code quirks: why `forceRotate` exists (an
  orphan writer after abort), `DISABLE_AUTO_COMPACT`, `--strict-mcp-config`,
  `ENABLE_CLAUDEAI_MCP_SERVERS=0`, `thinking-display: summarized`, and why
  rebuilding at the same UUID works.
- The REUSE/REBUILD idea and the `Case 1–4` debug anchors, unless the new
  logs replace them.

## Test plan

- The node suite (`npm test`, `node --import tsx`) can't load `src/index.ts`,
  because `@oh-my-pi/pi-coding-agent` needs bun. Keep logic that must be
  tested in modules that don't import it, or add a `bun test` suite.
- A fake `@anthropic-ai/claude-agent-sdk` `query` (async iterable of SDK
  messages) plus a fake `cc-session-io` should cover, before the rewrite
  lands:
  - a child's history import, with a cursor separate from the main one;
  - side requests leaving main state alone;
  - reentrant steer replay resuming the child's own session;
  - helper requests leaving the agent's session alone (cursor, abort, error);
  - abort during a continuation stopping it;
  - compaction and tree navigation leading to a rebuild.
- Write these against `port-baseline` first where possible, so the rewrite
  has a behavioural reference.

## Open decisions

- **Provider id and config names.** `claude-bridge`, `claude-bridge.json`
  and the MCP server name are unchanged and clash with upstream
  omp-claude-bridge if both are installed. Renaming changes the model ids
  users select (`claude-bridge/<model>`) and their config path.
- **Test runner.** Keep node plus pure modules, add `bun test`, or move
  everything to bun (CI already installs bun).
- **AskClaude shared mode.** Keep sharing with the provider session, or give
  AskClaude its own session per conversation. It can't find the provider
  session reliably without an OMP API change.
- **Upstream asks for OMP.** Expose the provider `sessionId` (or the
  `providerSessionState` map) on `ExtensionContext`, and give helper requests
  their own session ids.

## Suggested order

1. Add the fake-SDK test harness and the tests above against `port-baseline`.
2. Introduce the per-session owner object and move query state into it.
3. Replace count-based sync with prefix fingerprints.
4. Collapse abort and cleanup into one path.
5. Split `streamClaudeAgentSdk`.
6. Decide the provider id and config names, and update docs and CHANGELOG.
