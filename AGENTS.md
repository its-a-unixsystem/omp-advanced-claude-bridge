# omp-advanced-claude-bridge

Oh My Pi (OMP) extension that runs Claude Code, through the Claude Agent SDK,
as an OMP model provider (`claude-bridge`), plus an `AskClaude` delegation tool.
It is an independent continuation of DevVig/omp-claude-bridge.

## Current work

The `rewrite` branch rebuilds the provider's session and query core. Read
`documentation/in-progress/2026-11-26_session-core-rewrite.md` before touching
`src/index.ts`, `src/bridge-session.ts`, `src/query-state.ts`,
`src/request-kind.ts` or `src/history-sync.ts`. The tag `port-baseline` is the
behavioural reference.

## Commands

```bash
bun install
bun run typecheck   # tsc --noEmit
bun run test        # node unit suite, then the bun bridge suite
bun run test:bridge # bun test tests/ (src/index.ts against a fake Claude Agent SDK)
CLAUDE_BRIDGE_DEBUG=1 omp   # logs to ~/.omp/agent/claude-bridge.log
```

## Constraints

- `src/index.ts` imports `@oh-my-pi/pi-coding-agent`, which needs bun. The
  node test suite can't import it. Put logic that needs tests in modules that
  don't import it (like `src/models.ts`, `src/bridge-session.ts`,
  `src/query-state.ts`, `src/request-kind.ts`, `src/history-sync.ts`).
  Provider behaviour is tested under bun in `tests/bridge-*.test.ts`, with the
  harness in `tests/harness/`.
- `src/models.ts` has no runtime imports. Keep it that way.
- Context-window mappings come from measured Claude Agent SDK output, not
  advertised metadata.
- OMP sources for API questions are in `node_modules/@oh-my-pi/*/src`.
- TypeScript, ESM, tabs. Match the surrounding style.
- Task docs live in `documentation/<status>/` with a `# Task:` header.

## Design rules learned the hard way

- State belongs to the OMP session that owns it (keyed by provider
  `sessionId`, stored in `providerSessionState`), never to the module.
- When a review finds the same kind of bug twice in shared state, change the
  ownership model instead of guarding the reported line.
- Don't infer what kind of request something is (child, side request, helper)
  from global state or message counts.
