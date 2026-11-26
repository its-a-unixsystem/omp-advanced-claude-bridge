# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Save native Claude Code resume mappings for file-backed primary OMP sessions.
  Rewinds and forks can keep the matching transcript prefix and import the
  changed suffix.
- Report Claude Code rate-limit events through OMP's `after_provider_response`
  event using `anthropic-ratelimit-unified-*` headers.

### Changed
- Forked from [DevVig/omp-claude-bridge](https://github.com/DevVig/omp-claude-bridge)
  as the independently maintained project `omp-advanced-claude-bridge`
  (<https://github.com/its-a-unixsystem/omp-advanced-claude-bridge>), with
  updated documentation, fork attribution, and banner graphic.
- Ported the provider and AskClaude renderer to Oh My Pi 19.2.1. The bridge
  now uses OMP's bundled catalog, native streaming and tool-schema APIs, and
  reactive text nodes for AskClaude's call and result previews.
- Breaking: use `advanced-claude-bridge/<model>` for saved model selections
  and `advanced-claude-bridge.json` for global and project configuration.
  The SDK MCP server is now `advanced-claude-bridge-tools`, and the default
  delegation tool is `AskClaudeAdvanced`. See the
  [migration guide](README.md#migrating-from-the-old-names) for side-by-side use.
- Removed the `change-case` runtime dependency; the direct Anthropic SDK
  dependency is now used only for development types.
- Use Claude Code's default output style and disable auto-memory for provider
  and helper queries. Provider turns other than side requests can opt back in.
- Forward the full OMP system prompt by default. Set `systemPromptPreset` to
  `false` or `null` to use the OMP prompt without Claude Code's preset. Legacy
  `appendSystemPrompt: false` still opts out when no preset is set.

### Fixed
- Each OMP provider session now keeps its own Claude Code session. In-process
  subagents and `/btw` side requests no longer overwrite the main agent's
  session state, get their prior history imported, and replay deferred steers
  against their own session.
- Isolated helper requests and AskClaudeAdvanced do not change the primary
  session's transcript or saved mapping.
- Read SDK rate-limit utilization as a fraction and resets as Unix seconds.
- Normalize model-specific rate-limit headers and keep buffered events with
  the tool continuation that produced them.
- Verify the native bytes of a retained history prefix before copying it.
  On mismatch, rebuild from OMP history.
- Overlapping turns no longer share a writable Claude Code transcript. An
  edited or removed final reply triggers a rebuild, and deferred steers
  preserve images when replayed.
- Unsuffixed models use their only available context window when the configured
  default is unavailable. Explicit window suffixes still require that window.
- Claude Agent SDK failure results now surface as errors instead of empty
  successes, including in AskClaude.
- AskClaude rejects direct full-mode calls when `allowFullMode` is false
  without overriding a no-tools default. Already-aborted calls do not start
  Claude Code.
- Diagnostic logging no longer interrupts recovery, tool schema enums no longer
  crash provider turns, and history import preserves signed thinking from OMP's
  native Anthropic provider.
- The provider looks for `AGENTS.md` from each request's working directory.
- Empty session files no longer trigger a warning when zero records are
  expected. Session-file warnings link to this fork's issue tracker.

## [0.8.1] - 2026-07-07

### Fixed
- Spurious "Claude rate limit warning" toasts at trivial utilization. The Claude
  Agent SDK emits `allowed_warning` rate-limit events even at ~1% of the
  `seven_day` (weekly) limit; these are now surfaced only at ≥80% utilization.
  Hard-limit (`rejected`) notifications and the debug log are unchanged.

## [0.8.0] - 2026-07-07

### Added
- On-demand context-window variants in the `/model` picker: each model is now
  registered once per window it supports (1M and/or 200K) as a distinct,
  clearly-labeled entry (e.g. `Opus 4.8 (1M)` and `Opus 4.8 (200K)`). Switching
  a model's context window is a picker selection instead of a config edit plus
  reload.
- Suffixed model ids (`<model>-1m` / `<model>-200k`) that force a specific
  window regardless of the global default — usable from `modelRoles` and
  AskClaude short names. The unsuffixed id remains the config default, so
  existing `config.yml` roles keep working.

### Changed
- `provider.contextWindow` now sets the **default** window (which window the
  unsuffixed model id maps to) instead of hiding models that don't match it.
  Both windows stay pickable wherever a runtime exists.
- Each variant reports its true `contextWindow`, keeping the status bar and
  auto-compaction accurate for the selected window.

## [0.7.0] - 2026-07-06

First public release of the Oh My Pi port.

### Added
- `provider.contextWindow` setting with three modes:
  - `"auto"` (default) — per-model context policy based on measured SDK behavior.
  - `"1m"` — force the 1M context window; only 1M-capable models are registered.
  - `"200k"` — force the 200K context window; only 200K-capable models are registered.
- Models without a runtime for the selected forced window are hidden from the
  model picker instead of being misreported.
- `thinkingLevelMap` fallback so Sonnet 5 / Sonnet 4.6 expose `xhigh` (mapped to `max`).

### Changed
- Ported from Pi (`@earendil-works/*`) to Oh My Pi (`@oh-my-pi/*`): extension
  manifest (`omp.extensions`), provider registration, message conversion, and
  config directory resolution (`~/.omp/agent/claude-bridge.json`).
- Corrected the `claude-fable-5` context policy: the bare `claude-fable-5`
  runtime serves 200K (verified), while `claude-fable-5[1m]` serves 1M. In
  `"auto"` mode Fable 5 now registers at 200K.

### Credits
- Original `pi-claude-bridge` by [Eli Dickinson](https://github.com/elidickinson).
- Oh My Pi port and context-window controls by [Jonathan Borgwing](https://github.com/DevVig).
