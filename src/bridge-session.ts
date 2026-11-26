// Per-agent Claude Code session state.
//
// Extracted from index.ts so tests can import without activating the extension.

import type { ProviderResponseMetadata, ProviderSessionState } from "@oh-my-pi/pi-ai";
import { PROVIDER_ID } from "./convert.js";
import type { SessionState } from "./history-sync.js";
import type { QueryContext } from "./query-state.js";
import type { SessionStore } from "./session-store.js";

export interface TranscriptLease {
	state: SessionState | null;
	finish(next: SessionState | null): void;
}

// One sync state per OMP provider session. Main agents, in-process subagents
// and side requests carry their own provider sessionIds. Tool results are
// routed only to a live query in the session that sent them.
export class BridgeSession implements ProviderSessionState {
	state: SessionState | null = null;
	closed = false;
	readonly queries = new Set<QueryContext>();
	#writer?: symbol;
	#releasePersistence?: () => void;
	pendingResponse?: ProviderResponseMetadata;

	constructor(readonly id?: string, private readonly states?: Map<string, ProviderSessionState>) {}

	// Check out the idle transcript. An overlapping turn gets no prior state
	// and builds a separate transcript. Only the latest writer may publish
	// its state, regardless of the order in which the turns finish.
	beginTranscript(persistence?: { store: SessionStore; branchSource?: string }): TranscriptLease {
		const writer = Symbol();
		const { store, branchSource } = persistence ?? {};
		const id = this.id;
		const release = id && store ? store.acquire(id, this) : undefined;
		let state = this.state;
		if (!this.#writer && !state && release && store && id) {
			state = store.load(id);
			if (!state && branchSource) {
				const source = store.load(branchSource);
				if (source) state = { ...source, dirty: true };
			}
		}
		if (persistence && !release && state) state = { ...state, dirty: true };
		this.#writer = writer;
		this.#releasePersistence = release && (() => {
			try {
				if (state && id) store?.save(id, { ...state, dirty: true });
			} finally {
				release();
			}
		});
		this.state = null;
		return {
			state,
			finish: (next: SessionState | null) => {
				if (this.#writer !== writer) return;
				this.#writer = undefined;
				this.#releasePersistence = undefined;
				this.state = next;
				if (release && id) {
					try {
						if (next) store?.save(id, next);
					} finally {
						release();
					}
				}
			},
		};
	}

	// OMP aborts the agent's own turn before it closes the agent's sessions, but
	// side requests share the agent's map and run on their callers' signals, so
	// whatever still runs here is aborted. Nothing writes state after this.
	close(): void {
		this.closed = true;
		this.#writer = undefined;
		this.state = null;
		this.pendingResponse = undefined;
		this.#releasePersistence?.();
		this.#releasePersistence = undefined;
		const key = this.id ? `${PROVIDER_ID}:${this.id}` : undefined;
		if (key && this.states?.get(key) === this) this.states.delete(key);
		for (const query of this.queries) query.abort();
	}
	// OMP calls this on every entry of the agent's map when a side request
	// (other than a multi-turn side conversation) ends. A side request whose
	// answer was a tool call still has its query waiting for a tool result.
	releaseSession(sessionId: string): void {
		if (sessionId !== this.id) return;
		this.close();
	}
}

// Helpers without an owner map never touch an agent's transcript.
export function bridgeSession(sessionId: string | undefined, states: Map<string, ProviderSessionState> | undefined): BridgeSession | null {
	if (!sessionId || !states) return null;
	const key = `${PROVIDER_ID}:${sessionId}`;
	const existing = states.get(key);
	if (existing instanceof BridgeSession && !existing.closed) return existing;
	const session = new BridgeSession(sessionId, states);
	states.set(key, session);
	return session;
}
