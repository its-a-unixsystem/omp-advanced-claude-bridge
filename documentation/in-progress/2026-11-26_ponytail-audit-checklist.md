# Task: Ponytail audit findings checklist
**Date Started**: 2026-11-26
**Status**: In progress
**Branch**: `rewrite`
**Related**: `documentation/in-progress/2026-11-26_session-core-rewrite.md`

Actionable checklist from the 2026-11-26 `/ponytail-audit` pass. Items already covered by the session-core rewrite are tagged with their step.

## Must fix

- [ ] **1. Fallback models crash when `contextWindow` is forced to `1m` or `200k`** (`src/models.ts:L154-166`, `src/models.ts:L207-225`, `tests/unit-context-window.mjs:L128-133`)
  - When `forced` is unset and `resolveClaudeCodeRuntimeModel` returns `null`, fall back to the model's only available runtime (matching `buildVariantModels`) so Haiku under `1m` and Opus 4.7 under `200k` don't throw. Update unit test so only impossible explicit suffixes throw.
- [ ] **2. SDK error results are silently reported as empty successes** (`src/index.ts:L975-986`, `src/index.ts:L1471-1481`)
  - In `consumeQuery` and `promptAndWait`, check `message.subtype !== "success" || message.is_error`, extract the error with `resultErrorText(message)`, and emit an error on the provider stream / throw in `promptAndWait`.
- [ ] **3. `allowFullMode: false` can be bypassed by `defaultMode: "full"` or direct tool args** (`src/index.ts:L1606-1635`, `src/index.ts:L1713-1715`)
  - Clamp `defaultMode` to `"read"` when `!allowFull` and reject `mode === "full"` in `execute` when `!allowFull`.
- [ ] **4. `diagDump` crashes recovery paths when `~/.omp/agent` does not exist** (`src/index.ts:L41-49`, `src/index.ts:L93-98`)
  - Wrap `mkdirSync(dirname(DIAG_LOG_PATH), { recursive: true })` and `appendFileSync` in `try/catch` inside `diagDump`.
- [ ] **5. Non-string or empty tool schema enums crash every provider turn** (`src/typebox-to-zod.ts:L7-10`)
  - Only pass non-empty string arrays to `z.enum(...)`; handle mixed/non-string enums with `z.union(prop.enum.map((v) => z.literal(v)))` or fall back to `z.unknown()`.
- [ ] **6. Switching from OMP's built-in Anthropic provider drops all thinking blocks** (`src/convert.ts:L77-82`)
  - Check `msg.api === "anthropic-messages"` (instead of `"anthropic"`) so signed thinking blocks from OMP's native Anthropic provider are preserved.
- [x] **7. Abort during a steer continuation reports `stop` and leaves the session unrotated** (`src/index.ts:L1231-1300`) *(rewrite step 4)*
  - Check `wasAborted || options?.signal?.aborted` after steer replay too, mark `needsRebuild: true, forceRotate: true`, and end the stream with `"aborted"`. Turn `test.failing` in `tests/bridge-steer-abort.test.ts:L158` into `test`.
- [x] **8. Count-based history sync misses in-place rewrites and lets long helpers hijack the session** (`src/index.ts:L487-515`, `src/request-kind.ts:L50-52`) *(rewrite step 3)*
  - Replace count-based cursor matching with per-message prefix fingerprints. Turn `test.failing` in `tests/bridge-history.test.ts:L66` and `tests/bridge-sessions.test.ts:L218` into `test`.
- [x] **9. Aborted queries stay routable until `.finally`, and `close()` does not stop live queries** (`src/index.ts:L1211-1245`, `src/index.ts:L1320-1328`, `src/bridge-session.ts:L42-45`) *(rewrite step 4)*
  - Remove the query from `session.queries` immediately in `onAbort()`. Have `BridgeSession.close()` mark the session closed and abort all active queries.
- [x] **10. Aborted helpers leave orphan session files on disk** (`src/index.ts:L1231-1245`, `src/index.ts:L1294-1297`) *(rewrite step 4)*
  - Delete ephemeral helper sessions in the unified cleanup path (or use `persistSession: false` when steer replay isn't needed). Turn `test.failing` in `tests/bridge-sessions.test.ts:L192` into `test`.
- [ ] **11. Pre-aborted `AskClaude` calls spawn and leak a Claude Code subprocess** (`src/index.ts:L1400-1427`)
  - Check `if (signal?.aborted) throw new Error("Aborted");` before calling `query(...)` in `promptAndWait`.

## Should fix

- [ ] **12. `AGENTS.md` lookup ignores the request's `cwd`** (`src/agents-md.ts:L15-20`, `src/index.ts:L1100`, `src/index.ts:L1130`)
  - Pass `cwd` into `extractAgentsAppend(cwd)` and `resolveAgentsMdPath(cwd)`.
- [x] **13. Compaction and tree hooks invalidate every live session in the process** (`src/index.ts:L1582-1591`) *(rewrite step 3)*
  - Drop global `markRebuild` once prefix fingerprints detect per-session rewrites. Turn `test.failing` in `tests/bridge-history.test.ts:L77` into `test`.
- [ ] **14. Add missing unit/bridge tests for high-risk paths** (`src/convert.ts`, `src/typebox-to-zod.ts`, `src/index.ts:L267-409`, `src/session-verify.ts`)
  - Cover `convertPiMessages` (thinking signatures, tool ID sanitization, images), `jsonSchemaToZodShape` (enums, nested arrays), `verifyWrittenSession` (empty file, mismatch, drift), and `session_before_compact` takeover.
- [x] **15. Split `streamClaudeAgentSdk` by job** (`src/index.ts:L1015-1331`) *(rewrite step 5)*
  - Separate tool-result delivery, SDK option assembly, and query/abort/steer lifecycle into focused helpers with one cleanup path.
- [ ] **16. Remove dead code in `src/index.ts`** (`src/index.ts:L558-560`, `src/index.ts:L1343`, `src/index.ts:L1440-1457`)
  - Done in step 3: `export const __test` removed.
  - Delete unused `onStreamUpdate`, and the unreachable `stream_event` branch in `promptAndWait` (or enable `includePartialMessages: true` if live tool-start progress is wanted).
- [ ] **17. Trim unnecessary runtime dependencies** (`package.json:L49-51`, `src/convert.ts:L6`, `src/convert.ts:L30`)
  - Move `@anthropic-ai/sdk` to `devDependencies` (type-only import) and replace `change-case` with a small regex helper in `src/convert.ts`.

## Nice to have

- [ ] **18. Fix `verifyWrittenSession` empty-session false warning and upstream issue URL** (`src/session-verify.ts:L23-36`, `src/index.ts:L427`)
  - Return early when `lines.length === 0`, and point the warning link to `its-a-unixsystem/omp-advanced-claude-bridge/issues/new`.
