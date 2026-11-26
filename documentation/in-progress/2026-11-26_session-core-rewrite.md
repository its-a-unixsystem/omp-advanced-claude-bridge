# Task: Rewrite the provider's session and query core
**Date Started**: 2026-11-26
**Status**: In progress (steps 1–6 done)
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

Struck-through entries are fixed on `rewrite`; the step that fixed them is
noted.

- ~~**Reentrancy is process-wide.**~~ (step 2) `ctx()` is one top-level `QueryContext`,
  and `isReentrant = ctx().activeQuery !== null`. A request from one session
  is treated as reentrant because another session is busy.
- ~~**History is matched by counting messages.**~~ (step 3) The cursor is a message
  count. REUSE assumes "nothing new after the cursor" means "same history";
  the preserve path assumes "shorter context" means "helper request". Any
  history rewrite that no hook reports breaks this silently.
- ~~**A same-`sessionId` helper with a longer context**~~ (step 3) (OMP advisors and
  maintenance requests can reuse the agent's `sessionId`) skips the preserve
  path and replaces the agent's session state on completion. Step 3 found
  that no OMP 19.2.1 request has this shape; see "Step 3" below.
- ~~**The orphaned tool-result path**~~ (step 3) (tool result, no active query) writes
  the cursor of whatever session `options` names. Since step 2 that is
  always the session the result came from, but a same-`sessionId` helper's
  orphaned result still moves the agent's cursor. Since step 3 an orphaned
  result writes no sync state, and helpers can't reach the agent's session.
- **AskClaude:**
  - It never advances the sync state, so the next provider turn rebuilds.
  - It looks up the session by session-file id, which misses the provider
    session after `freshSession()`.
  - It builds its context with `buildSessionContext(getBranch())`, not the
    provider's converter. Since step 3 it compares content instead of
    counts, so it reuses the provider's session only when both builders
    produce the same messages, and rebuilds the shared session otherwise.
  - Entries created only by AskClaude live until main `session_shutdown`.
  - A call whose signal is already aborted still starts Claude Code:
    `promptAndWait` calls `query()` before it checks the signal, and the
    `throw` skips the `finally` that closes the query (checklist 11).
- ~~**Hook invalidation is too broad.**~~ (step 3) Compact, tree and branch mark every
  live session for rebuild, because hooks can't tell which session is
  theirs.
- ~~**Abort cleanup lives in four places**~~ (step 4) (`onAbort`, the abort branch after
  completion, `.catch`, `.finally`).
- **Steer replay output** goes into the same pi stream turn. Check how OMP
  renders continuation output after a tool-result turn.
- ~~**Abort during a continuation**~~ (step 4) ends the stream with `stop`, not
  `aborted`, and leaves the session marked healthy. The next turn resumes
  the session the killed process may still write to.
- ~~**An aborted helper leaks its ephemeral session.**~~ (step 4) The abort branch returns
  before the session file is deleted.
- ~~**An aborted query stays routable until its cleanup.**~~ (step 4) A tool
  result or prompt that arrives while Claude Code is still exiting joins the
  dead query; its stream ends with that query's abort, or never.
- ~~**`close()` doesn't stop the session's queries**~~ (step 4), and a query
  that ends after `close()` writes its state into the closed session.
- ~~**A helper whose turn ends with a tool call never ends.**~~ (step 4) Judges
  retry with a forced `SUBMIT_JUDGMENT` call and never send a tool result.
  The query waits on its MCP handler forever and keeps its session file.
- ~~**Side requests are never released.**~~ (step 4) OMP calls
  `releaseSession(sideSessionId)` after each side request; the bridge didn't
  implement it, so a side request answered with a tool call kept its query
  waiting until the agent's session closed.
- **`toolChoice` is ignored.** The bridge doesn't pass OMP's `toolChoice` to
  Claude Code, so a judge's forced `SUBMIT_JUDGMENT` call may come back as
  text.
- **A provider request whose signal is already aborted still starts a
  Claude Code query**, which the abort then closes right away.
- ~~**Consecutive queries share the top-level context.**~~ (step 2) The previous query's
  `.finally` runs after its stream has completed and removes that context
  from `activeQueryContexts`. A turn that starts before the cleanup has its
  tool results treated as orphaned, and its MCP handler never resolves.
- ~~**An orphaned tool result resets the top-level context**~~ (step 2), which may belong
  to another session's turn in progress. That turn loses its streamed content.

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

## Behavioural tests

`bun run test:bridge` (`bun test tests/`) loads `src/index.ts` with a fake
Claude Agent SDK and drives it through a fake OMP extension API:

- `tests/harness/fake-claude.ts`: `query` takes scripted async generators of
  SDK messages, calls the bridge's MCP tool handlers, and behaves like
  Claude Code's session persistence (resuming a missing session fails; each
  prompt, assistant message and tool result is appended to the JSONL).
  `FakeQuery.holdExit()` keeps a closed query's iteration open, like a
  Claude Code process that takes a while to exit.
- `tests/harness/session-files.ts`: real cc-session-io in a temporary
  `CLAUDE_CONFIG_DIR`, with `createSession`/`deleteSession` recorded, and a
  transcript comparison between a session file and OMP's history.
- `tests/harness/bridge.ts`: module mocks, the fake extension API, message
  builders, and per-test reset.

The tests cover the cases listed under "Test plan" against `port-baseline`.
Each known defect above that the harness can reproduce is a `test.failing`
with a comment; the rewrite should turn them into plain `test`s. Not yet
covered: the AskClaude defects (they depend on the AskClaude shared-mode
decision). The process-wide reentrancy flag had no observable effect of its
own beyond the two top-level-context defects; step 2 removed it with them.

## Open decisions

- **Test runner.** Step 1 added a `bun test` suite next to the node unit
  suite, because only bun can load `src/index.ts`. `bun run test` runs both.
  Moving the node suite to bun is still open.
- **AskClaude shared mode.** Keep sharing with the provider session, or give
  AskClaude its own session per conversation. It can't find the provider
  session reliably without an OMP API change.
- **Upstream asks for OMP.** Expose the provider `sessionId` (or the
  `providerSessionState` map) on `ExtensionContext`, and give helper requests
  their own session ids.

## Suggested order

1. ~~Add the fake-SDK test harness and the tests above against `port-baseline`.~~ Done.
2. ~~Introduce the per-session owner object and move query state into it.~~ Done.
3. ~~Replace count-based sync with prefix fingerprints.~~ Done.
4. ~~Collapse abort and cleanup into one path.~~ Done.
5. ~~Split `streamClaudeAgentSdk`.~~ Done.
6. ~~Decide the provider id and config names, and update docs and CHANGELOG.~~ Done.

## Step 2: per-session owner (done)

What changed:

- `BridgeSession` (`src/bridge-session.ts`) owns its running queries in
  `queries: Set<QueryContext>`, next to its sync state (`state`). A query
  joins the set when its SDK query starts and leaves it in the query's
  `.finally`.
- `QueryContext` (`src/query-state.ts`) is created per query with
  `new QueryContext(helper)`. `ctx()`, the top-level context, the
  `activeQuery` field, `ownedSession`, the module set `activeQueryContexts`
  and the `isReentrant` flag are gone. `ownsToolCall(id)` answers whether
  the query issued a tool call (waiting handler, queued result, or a tool
  use of the current assistant message).
- `classifyRequest(messages, session)` (`src/request-kind.ts`, no OMP
  runtime imports) decides each provider request's kind once: `tool-results`
  (with the owning query and whether a steer follows), `orphaned-result`,
  `helper` or `turn`. It looks only at the request's messages and the
  session its `sessionId` names. Node unit tests:
  `tests/unit-request-kind.mjs`.
- The helper decision moved out of `syncSession`. The predicate is still
  the count-based one (`shorterThanSynced`: history before the prompt is
  shorter than the cursor and no rebuild is pending); step 3 replaces it.
  `syncSession` now returns the resume id or `null`. Helpers skip it and
  start clean, as before. The `Case 1 synthetic` debug anchor is kept at
  the new call site.
- AskClaude calls `shorterThanSynced` before `syncSession`, which keeps its
  old behaviour (a shorter context resumes the provider's session without
  syncing) until the shared-mode decision.
- The orphaned-result path builds its own `stop` message instead of
  resetting a shared context.
- Cleanup, only where ownership forced it: the error path no longer drains
  waiting MCP handlers, because only the top-level context drained there.
  `.finally` now always drains, which reentrant queries already relied on.
- `processAssistantMessage` skips SDK `assistant` messages whose id already
  arrived as stream events (`QueryContext.streamedMessageIds`). See below.

What I learned:

- **A session can have more than one live query.** A helper under the
  agent's `sessionId` can start while the agent's turn waits on a tool. So
  the owner holds a set, and tool results go to the query that owns the
  call ids, not to "the" query.
- **Tool results can arrive before the SDK repeats the tool-use message.**
  The SDK yields each API message twice: as stream events, then as an
  `assistant` message. The old comment said leftovers were safe because the
  tool-use turn nulls `currentPiStream`. That only holds if the tool takes
  longer than Claude Code needs to emit the `assistant` record. When the
  result comes first, delivery resets `turnSawStreamEvent`, the fallback
  takes the leftover for new content, streams the tool call again and ends
  the turn with `toolUse`. The cleanup-race test hit this as soon as its
  tool result stopped being orphaned. Matching the Anthropic message id
  fixes it at the source. The bug was in `port-baseline` too, hidden behind
  the orphan defect.
- **Requests without a `sessionId` can't receive tool results.** Each one
  gets a throwaway `BridgeSession`, as before, but routing is now per
  session, so their tool results land as orphaned. `port-baseline` routed
  them through the process-wide set. OMP agents always pass a `sessionId`:
  `Agent` forwards its own (`pi-agent-core/src/agent.ts`), and advisors use
  their own provider session id (`session-advisors.ts`).
- For step 4:
  - A query stays in `session.queries` until `.finally`. After an abort,
    `turnToolCallIds` still names the aborted call, so a tool result that
    arrives before `.finally` routes to the dead query. If the query's
    completion already ran, the new stream never ends. `port-baseline` had
    the same window with `activeQueryContexts`.
  - `BridgeSession.close()` doesn't stop the session's queries. A query
    that completes after its session closed still writes `state` into the
    closed object.
- Module globals left: `piUI`, `bridgeSessions`, `providerSettings`,
  `longContextSettings` and `askClaudeToolName`, plus `completedStreams`
  and `nextCliDebugSeq`.

## Step 3: prefix fingerprints (done)

What changed:

- `planSync(state, messages)` (`src/history-sync.ts`, no OMP runtime
  imports) decides REUSE, REBUILD or clean start. `syncSession` in
  `src/index.ts` calls it and does the file work. Node unit tests:
  `tests/unit-history-sync.mjs`.
- `SessionState` holds `cursor` (how many OMP messages the Claude Code
  session holds) and `prefix`, a fingerprint of those messages: a SHA-1 over
  per-message hashes of role and content (plus `toolCallId` and `isError` for
  tool results). Timestamps, usage and other metadata are left out. REUSE
  needs the request's history before the prompt to start with that exact
  prefix. `cursor` alone no longer decides anything; it stays because the
  prefix is a chained hash, which needs its length.
- The bridge's final reply: when a query ends, the session records
  `reply`, the timestamp of the final assistant message it handed OMP. The
  next request may have exactly one message after the prefix: an assistant
  message with that timestamp. That is the old `trailingAssistantOnly` case.
  It matches on the timestamp the bridge set (OMP keeps it:
  `snapshotAssistantMessage` in `pi-agent-core/src/agent-loop.ts` spreads the
  message). It doesn't match on content, because OMP rewrites tool arguments
  through `prepareArguments` and may add fields like `duration`. From then on
  the message is hashed as OMP sends it. Another model's answer in that slot
  is now missed history (REBUILD). The count-based check took any assistant
  message.
- Bridge-produced messages in the middle of a query (tool-use turns, the
  assistant messages that precede tool results) come back inside tool-result
  requests. Each delivery sets `QueryContext.synced` to the fingerprint of
  that whole context, and the query's completion writes it into the session
  state, with `reply`. So the fingerprint always describes OMP's view of what
  the session holds. Nothing is written to the session state mid-query
  anymore, and the orphaned-result path writes nothing at all.
- **Ownership by `providerSessionState`.** `bridgeSession(sessionId, states)`
  returns a session only when the request brings both. Requests without the
  map own no session. `classifyRequest(messages, null)` calls them `helper`
  (or `orphaned-result`). They run clean on a throwaway `BridgeSession`, and
  their Claude Code session is deleted afterwards. `shorterThanSynced`,
  `QueryContext.helper` and `latestCursor` are gone. AskClaude uses
  `sharedSession(sessionId)`, the registry lookup that provider requests
  used to fall back to.
- The `session_compact`, `session_tree` and `session_branch` handlers
  (`markRebuild`) are gone. The next turn's fingerprint sees the rewrite in
  the one session it happened to. `needsRebuild` is now set only after an
  abort.
- `__test` (export of `syncSession`) is gone.
- Debug anchors: `Case 1`–`Case 4` and `Case 4 post-abort` stay. `Case 4`
  now logs `history diverged` or `history flagged` instead of a missed-count.
  `Case 1 synthetic` now marks a request without `providerSessionState`
  (`syncResult: path=clean-start helper`). New: `provider: synced
  session=…, cursor=…` when a query writes its sync state.

Tests:

- Now plain `test`s: "a history rewrite no hook reports is detected by
  content", "compaction in one session leaves other sessions' Claude Code
  sessions alone", "a helper with a longer context does not take over the
  agent's session".
- With approval: the helper tests (completed, aborted, abort-leak, failed)
  send no `providerSessionState`, the way OMP's helpers do. "A helper with a
  longer context" had an unreachable expectation: it compared the transcript
  after the agent's turn with the history before that turn. It now expects
  the agent's history plus its own turn, with no helper exchange. It still
  sends the agent's map. OMP never sends that shape, but if it did, the
  helper would run as the agent's turn, and the agent's next turn would
  rebuild without it.
- The two step-4 `test.failing` tests still fail.

What I learned:

- **Which OMP 19.2.1 requests reuse the agent's provider `sessionId`.**
  - With the agent's `providerSessionState`: the agent's own turns, and
    OMP-native compaction summaries (`session-maintenance.ts` → `compact()`;
    one user message holding the serialized conversation). Our
    `session_before_compact` takeover handles those while claude-bridge is
    the session model. When it isn't, a summary on a claude-bridge model is
    treated as the agent's turn, and the next claude-bridge turn rebuilds,
    as a compaction needs anyway.
  - Without the map, each with a single message: judges (`judgment/index.ts`
    → `chatTextBackend`: TTSR, auto-graph, title-drift, auto-prewalk,
    auto-parallel planner; they fall back to the session model), the title
    model, auto-repair, magic edit, the TTS enhancer, memories and
    sharpshooter.
  - The full history: title fork, `/btw`, recap, handoff, composer
    prediction, omfg and the completion probe. All go through
    `runEphemeralTurn` with a `:side:` id. Advisors use their own id.
  - So "helper or turn" is decided by the map, and "same or rewritten
    history" by content. Content alone couldn't tell a helper from a rewrite
    back to the first message.
- **The fingerprint describes OMP's view, not the JSONL.** After a steer
  continuation, Claude Code's session also holds the reply to the tool
  result that preceded the steer, which OMP never received as its own
  message (see "Steer replay output"). REUSE accepts that, as before.
- **OMP rewrites history in place.** `pruneToolOutputs` blanks old tool
  results under the same timestamp, and OMP treats that as a history rewrite
  (it closes Codex provider sessions for it). The fingerprint sees it and
  rebuilds, so Claude Code's context shrinks too. Count-based sync kept the
  full outputs. The same goes for any OMP transform that changes earlier
  messages between requests: each change costs one rebuild.
- Hashing runs over the whole history on every turn and tool-result
  delivery. Per-message hashes aren't cached by object, because OMP mutates
  messages in place (pruning), so a cache would miss exactly those rewrites.
- For step 4 (not verified): a map-less helper that forces a tool call
  (judges retry with `SUBMIT_JUDGMENT` and `toolChoice`) leaves its Claude
  Code query waiting on an MCP handler no tool result will ever reach.
  `port-baseline` had the same leak in the agent's session.

## Step 4: one end path per query (done)

What changed:

- Every query ends in one place: `endQuery` in `streamClaudeAgentSdk`,
  called once with `done`, `aborted` or `error`. In this order it clears the
  deferred steers, takes the query out of `session.queries` and writes the
  sync state (`BridgeSession.endQuery`), resolves waiting MCP handlers, and
  pushes the stream's terminal event: `done`, or `error` with reason
  `aborted` or `error`. The state is written before the terminal event, so
  OMP's next request sees it. An abort also interrupts and closes whichever
  SDK query is running (the main one or a continuation). The four old places
  (`onAbort`, the abort branch in `.then`, `.catch`, `.finally`) are gone.
- An abort ends the query when it fires, not when Claude Code exits.
  Completion and errors end it when the consumer and the steer replays
  finish. Once the SDK iteration is over (`.finally`), the SDK query is
  closed and a helper's ephemeral session deleted, whatever the end was.
- `stateAfterQuery(state, end)` (`src/bridge-session.ts`, node unit tests in
  `tests/unit-bridge-session.mjs`) decides the state a query leaves:
  `done` writes the synced history and reply (the step-3 decision,
  unchanged), `aborted` sets `needsRebuild` + `forceRotate` (or leaves no
  state), `error` clears it. `BridgeSession.endQuery` applies it unless the
  session is closed.
- `QueryContext` has its own abort signal (`abort()`, `aborted`, `signal`).
  The request's signal forwards to it, and so does `BridgeSession.close()`.
  The provider path's `wasAborted` flag is gone. `claudeSessionId` holds the
  Claude Code session (the resume id, then the init message's id), so an
  aborted or failed helper's session is deleted too. `drainToolCalls`
  replaces the two drain loops.
- `BridgeSession.close()` marks the session `closed`, drops its state and
  aborts its live queries. `releaseSession(id)` closes the session with that
  id and removes it from the map that holds it (`BridgeSession.states`).
- Requests without `providerSessionState` own no session at all; the
  throwaway `BridgeSession` is gone. Their tool-use turn is their last:
  `consumeQuery(…, endOnToolUse)` stops after it, and the query ends `done`
  with the `toolUse` message as its answer.
- A continuation that throws now ends the query with `error` (no sync
  state). Before, the error was swallowed, the stream ended with `stop` and
  the session was marked healthy.
- Main `session_shutdown` closes only sessions no provider map holds (the
  ones AskClaude created). See below.

Debug lines: `provider: consumeQuery completed …`, `provider: abort detected,
marked session needsRebuild + forceRotate`, `provider: query done, helper=…`,
`provider: query error, model=…` and `provider: continuation query error:`
are replaced by one `provider: query ended, end=…, helper=…, session=…,
stopReason=…[, error=…]`. It is followed by `provider: synced session=…,
cursor=…` (as in step 3), `provider: abort marked session … needsRebuild +
forceRotate`, or `provider: session … closed, sync state dropped`.
`consumeQuery: for-await loop exited` now logs `aborted=` and `session=`.
The `Case 1`–`Case 4` anchors are unchanged.

What I learned:

- **When OMP closes provider sessions, the agent's turn is already
  aborted.** `newSession`, `switchSession` and `reload` run `await abort()`,
  which waits for the agent to go idle. `dispose` calls `agent.abort()`
  before `#closeAllProviderSessions`. `freshSession` and
  `resetSessionContext` refuse while streaming. So `close()` only meets an
  agent query that is already aborted, though maybe still in cleanup.
- **Side requests can still run when the agent's sessions close.** They
  share the agent's map, but run on their callers' signals, which
  `AgentSession.abort()` doesn't touch. Interactive mode disposes `/btw` and
  omfg before a switch or dispose. Recap (idle maintenance), composer
  prediction, the completion probe and extension ephemeral turns aren't
  stopped. With approval, `close()` aborts whatever still runs.
- **Side requests send the agent's tools** (unless `tools: false`).
  `runEphemeralTurn` takes a `toolUse` message as the answer and never sends
  a tool result. In its `finally` it calls `releaseSession(sideSessionId)`
  on every map entry, except for multi-turn side conversations
  (`conversationKey`).
- **`dispose` emits `session_shutdown` before it aborts the agent's turn.**
  The agent loop races the provider stream against its signal. When OMP
  aborts, it builds the aborted message itself, from the abort reason. On
  dispose that reason is `INTERRUPTED_TURN_ERROR`, which `omp --restore`
  uses to find an interrupted turn (`isInterruptedTurnAbort`). Had
  `session_shutdown` closed the agent's session, the bridge would have ended
  the stream first, with its own "Operation aborted", and the label would
  be lost. So shutdown leaves map-held sessions to OMP, which closes them
  after the abort.
- **An abort has to decide the sync state when it fires.** Claude Code can
  take a moment to exit after `close()`. A prompt that arrives in that window
  starts a new turn. If the state still said "healthy", that turn would
  resume the session, or rebuild it in place (`deleteSession` +
  `createSession` under the same id), while the dying process still writes
  to it. That is the orphan-writer race `forceRotate` exists for.
- **The helper note from step 3 was real.** Reproduced in the harness: the
  stream ended with `toolUse`, the query stayed open, its MCP handler never
  returned and its session file stayed. `close()` can't reach it, because a
  map-less request has no session to close. A request without a session can
  never receive a tool result (`classifyRequest` routes results only within
  a session), so ending its query after the tool-use turn follows from
  ownership, not from guessing. The bridge also ignores `toolChoice` (new
  known defect).
- Deleting a helper's session after the SDK iteration ends is best effort.
  A real Claude Code process killed by an abort may still append a record
  after `close()` returns, which recreates the file. The fake can't show
  this.
- Steer replay output: nothing new. Continuations still stream into the
  tool-result request's stream. An abort during a replay now ends that
  stream with `aborted`.
- `promptAndWait` (AskClaude) has its own abort handling and doesn't share
  this path. A pre-aborted call still starts Claude Code there (checklist
  11, listed under AskClaude). The provider path still starts a query for a
  pre-aborted request too, but its abort closes it at once.

Tests:

- Now plain `test`s: "an aborted helper leaves no session file behind" and
  "abort during a continuation reports the abort and moves the next turn to
  a new session".
- New, each failing on the step-3 code first:
  - "a tool result that arrives between an abort and the query's cleanup is
    orphaned" and "a prompt sent between an abort and the query's cleanup
    starts a new turn in a new session" (`bridge-steer-abort`, using
    `holdExit`).
  - "closing a session stops its running query", "a query running when its
    session closes writes nothing into it", "releasing a side request stops
    its query and forgets its session", "a helper's tool call ends its query
    and deletes its session" (`bridge-sessions`).
- New guards that already passed on the step-3 code: "an aborted query
  writes nothing into a session closed before its cleanup" (OMP's own
  order: abort, then close; the old abort branch wrote only when state was
  set, and `close()` had cleared it), and "main shutdown leaves the agent's
  running turn to OMP". The latter fails if shutdown closes every session.
- Node unit tests for `stateAfterQuery`, `close()` and `releaseSession`.
- No existing test changed beyond the two `test.failing` markers.

## Step 5: split the provider stream (done)

`streamClaudeAgentSdk` now classifies and dispatches. `deliverToolResults`
routes results to waiting MCP handlers or queues them, and records the
synced history and any steer. `startProviderQuery` prepares the prompt and
calls `syncSession` for an owned turn. `buildProviderQueryOptions` assembles
only the provider's SDK options. `consumeQuery` still translates SDK events;
`consumeAndReplay` resumes the query's Claude Code session for each steer.
`classifyRequest` and `planSync` remain pure in their existing modules.

`runProviderQuery` owns the abort target and the single `endQuery` closure.
Completion, errors, and abort all go through it; `close()` and
`releaseSession()` reach it through the query's abort signal. It removes
routing and updates sync state before emitting the terminal event.
Abort interrupts and closes the active SDK iterator to make it stop; final
SDK cleanup and deletion of a helper's session wait for iteration to end.
A helper still stops after its tool-use turn.

What I learned:

- Tool-use completion ends an OMP stream, not necessarily the query.
  Tool-result delivery attaches the next stream to the same query, and
  steer replay uses that stream. The replay tests assert the final reply,
  not how OMP displays the tool-result turn and the continuation together.
- The provider still creates the SDK query before checking a pre-aborted
  signal. It still does not map `toolChoice`. AskClaude and isolated
  compaction keep their own option builders and abort handling.
- OMP's stream already exposes whether it ended, so the overwrite warning
  no longer needs `completedStreams`. The provider callback and the
  AskClaude registration now use the same locally configured tool name
  instead of the `askClaudeToolName` global.

Globals kept:

- `piUI`: provider callbacks have no UI context; warnings still go to the
  main agent's UI between `session_start` and `session_shutdown`.
- `bridgeSessions`: AskClaude has no provider-state map, and main shutdown
  needs to find sessions that only AskClaude created. OMP still closes
  sessions its maps own.
- `providerSettings`: extension configuration shared by the provider and
  AskClaude's executable selection.
- `longContextSettings`: the model registration, provider, AskClaude and
  isolated compaction use the same runtime-model policy.
- `nextCliDebugSeq`: one sequence for CLI log names across the provider,
  continuations, AskClaude and isolated compaction.

No debug lines were renamed or removed. The Case 1–4 anchors still mark the
same decisions. No tests changed.

## Step 6: separate the upstream namespaces (done)

- OMP provider: `advanced-claude-bridge`. Model IDs keep their existing
  suffixes. The old provider ID is recognized only when importing signed
  thinking from older transcripts, not registered as an alias.
- Global and project configuration: `advanced-claude-bridge.json`. The
  project file still overrides the global file. There is no fallback to
  upstream's filename.
- SDK MCP server: `advanced-claude-bridge-tools`. OMP tool names are unchanged.
- Default delegation tool: `AskClaudeAdvanced`. `askClaude.name` still
  overrides the default.
- Migration steps are in the [README](../../README.md#migrating-from-the-old-names).
