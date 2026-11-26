// Per-agent Claude Code session state.
//
// Extracted from index.ts so tests can import without activating the extension.

import type { ProviderSessionState } from "@oh-my-pi/pi-ai";
import { PROVIDER_ID } from "./convert.js";
import type { SyncedHistory } from "./history-sync.js";
import type { QueryContext } from "./query-state.js";

export interface SessionState {
	sessionId: string;
	cwd: string;
	// The OMP history the Claude Code session holds: its first `cursor`
	// messages, fingerprinted by `prefix` (see history-sync.ts). The next
	// request reuses the session only if its history starts with them.
	cursor: number;
	prefix: string;
	// OMP appends this reply after the turn; Claude Code already has it.
	reply?: { timestamp: number; digest: string };
	// AskClaude writes a prompt and reply that aren't OMP conversation turns.
	// The idle transcript can be rebuilt in place but must not be resumed as-is.
	needsRebuild?: boolean;
}

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
	// The providerSessionState map that holds this session. Unset for entries
	// only AskClaude created.
	states?: Map<string, ProviderSessionState>;
	constructor(readonly id?: string) {}

	// Check out the idle transcript. An overlapping turn gets no prior state
	// and builds a separate transcript. Only the latest writer may publish
	// its state, regardless of the order in which the turns finish.
	beginTranscript(): TranscriptLease {
		const writer = Symbol();
		this.#writer = writer;
		const state = this.state;
		this.state = null;
		return {
			state,
			finish: (next: SessionState | null) => {
				if (this.#writer !== writer) return;
				this.#writer = undefined;
				this.state = next;
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
		if (this.id && bridgeSessions.get(this.id) === this) bridgeSessions.delete(this.id);
		for (const query of this.queries) query.abort();
	}

	// OMP calls this on every entry of the agent's map when a side request
	// (other than a multi-turn side conversation) ends. A side request whose
	// answer was a tool call still has its query waiting for a tool result.
	releaseSession(sessionId: string): void {
		if (sessionId !== this.id) return;
		this.close();
		const key = `${PROVIDER_ID}:${sessionId}`;
		if (this.states?.get(key) === this) this.states.delete(key);
	}
}

export const bridgeSessions = new Map<string, BridgeSession>();

// The session a provider request owns. Only a request that brings its agent's
// providerSessionState owns one. OMP helpers (judges, the title model,
// auto-repair) reuse the agent's sessionId without the map; they get null and
// run without touching the agent's session.
export function bridgeSession(sessionId: string | undefined, states: Map<string, ProviderSessionState> | undefined): BridgeSession | null {
	if (!sessionId || !states) return null;
	const session = sharedSession(sessionId);
	session.states = states;
	states.set(`${PROVIDER_ID}:${sessionId}`, session);
	return session;
}

// AskClaude shared mode: tools see neither the provider sessionId nor the map,
// so AskClaude looks the session up by the session-file id.
export function sharedSession(sessionId: string | undefined): BridgeSession {
	if (!sessionId) return new BridgeSession();
	const session = bridgeSessions.get(sessionId) ?? new BridgeSession(sessionId);
	bridgeSessions.set(sessionId, session);
	return session;
}
