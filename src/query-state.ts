// Query state: one QueryContext per SDK query.
//
// All per-query and per-turn mutable state lives here. A query that owns a
// session (see bridge-session.ts) is held in its `queries` until the query ends
// or is aborted. Adding a new field = one property on the class.
//
// Extracted from index.ts so tests can import without activating the extension.

import type { AssistantMessage, AssistantMessageEventStream, Model } from "@oh-my-pi/pi-ai";
import type { McpResult } from "./extract-tool-results.js";
import type { SyncedHistory } from "./history-sync.js";

export interface PendingToolCall {
	toolName: string;
	resolve: (result: McpResult) => void;
}

export class QueryContext {
	currentPiStream: AssistantMessageEventStream | null = null;
	// The Claude Code session the query runs in: the one it resumed, then the
	// one its init message names.
	claudeSessionId?: string;
	// Fired by the request's signal or by the query's session closing.
	readonly #abort = new AbortController();
	// The latest history OMP sent this query: its first request, then each
	// tool-result delivery. Becomes the session's sync state when the query ends.
	synced: SyncedHistory = { cursor: 0, prefix: "" };
	pendingToolCalls = new Map<string, PendingToolCall>();
	pendingResults = new Map<string, McpResult>();
	turnToolCallIds: string[] = [];
	nextHandlerIdx = 0;
	deferredUserMessages: string[] = [];
	// Anthropic message ids whose content arrived as stream events. The SDK
	// repeats each one as an `assistant` message, which may arrive after a tool
	// result already started the next turn.
	streamedMessageIds = new Set<string>();

	// Per-turn (reset together)
	turnOutput: AssistantMessage | null = null;
	turnStarted = false;
	turnSawStreamEvent = false;
	turnSawToolCall = false;

	get turnBlocks(): Array<any> {
		if (!this.turnOutput) throw new Error("turnBlocks accessed before resetTurnState");
		return this.turnOutput.content;
	}

	get signal(): AbortSignal {
		return this.#abort.signal;
	}

	get aborted(): boolean {
		return this.#abort.signal.aborted;
	}

	abort(): void {
		this.#abort.abort();
	}

	/** Resolve every waiting MCP handler with `text` and drop queued results. */
	drainToolCalls(text: string): void {
		for (const pending of this.pendingToolCalls.values()) pending.resolve({ content: [{ type: "text", text }] });
		this.pendingToolCalls.clear();
		this.pendingResults.clear();
	}

	/** Whether this query issued the tool call with this id. */
	ownsToolCall(id: string): boolean {
		return this.pendingToolCalls.has(id) || this.pendingResults.has(id) || this.turnToolCallIds.includes(id);
	}

	resetTurnState(model: Model<any>): void {
		this.turnOutput = {
			role: "assistant", content: [],
			api: model.api, provider: model.provider, model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop", timestamp: Date.now(),
		};
		this.turnStarted = false;
		this.turnSawStreamEvent = false;
		this.turnSawToolCall = false;
		// turnToolCallIds and nextHandlerIdx are NOT reset — they persist across
		// tool-result delivery callbacks within the same assistant message.
	}
}
