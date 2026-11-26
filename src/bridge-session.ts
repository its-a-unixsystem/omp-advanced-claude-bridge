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
	// Timestamp of the last query's final reply. OMP appends that message to
	// its history after the turn, and Claude Code's session already has it.
	reply?: number;
	// Force the next syncSession call down the REBUILD path. Set after an abort
	// left the JSONL in an indeterminate state. REBUILD wipes and rewrites the
	// file to match pi's current history.
	needsRebuild?: boolean;
	// Set ONLY after an abort. The killed CC subprocess may still be flushing
	// a late "[Request interrupted by user]" record to the session JSONL.
	// Reusing the same sessionId/path would race that orphan write into our
	// fresh file and break CC's parent-uuid chain on the next resume. When
	// this flag is set, REBUILD takes a fresh UUID and skips deleteSession
	// so the orphan writes land on a dead inode. History rewrites (compact,
	// tree) do NOT set this — there's no concurrent CC writer during those
	// events, so in-place rebuild (preserve UUID, deleteSession +
	// createSession) is safe.
	forceRotate?: boolean;
}

// How a query ended, and so which sync state it leaves behind.
export type QueryEnd =
	// The query finished in Claude Code session `sessionId`, which now holds
	// `synced` and the final reply OMP is about to append.
	| { kind: "done"; sessionId?: string; cwd: string; synced: SyncedHistory; reply?: number }
	// Stopped by its request's signal or by its session closing. The killed
	// Claude Code process may still write to the session (see forceRotate).
	| { kind: "aborted" }
	// Whatever the session holds now is unknown; the next turn starts over.
	| { kind: "error" };

export function stateAfterQuery(state: SessionState | null, end: QueryEnd): SessionState | null {
	switch (end.kind) {
		case "done":
			if (!end.sessionId) return state;
			return { sessionId: end.sessionId, cwd: end.cwd, ...end.synced, reply: end.reply };
		case "aborted":
			return state ? { ...state, needsRebuild: true, forceRotate: true } : null;
		case "error":
			return null;
	}
}

// One Claude Code session per OMP provider session. Main agents, in-process
// subagents and side requests each carry their own provider sessionId, so their
// sync state and resume ids never mix. Entries live in OMP's providerSessionState
// map, which closes them on new/switched/fresh sessions and on dispose.
//
// The session also owns its running queries. Usually there is one, but nothing
// stops a second request with the same sessionId and map from starting while a
// turn waits on a tool. Tool results are routed only to queries of the session
// that sent them, and a query leaves the session as soon as it ends or is
// aborted.
export class BridgeSession implements ProviderSessionState {
	state: SessionState | null = null;
	closed = false;
	readonly queries = new Set<QueryContext>();
	// The providerSessionState map that holds this session. Unset for entries
	// only AskClaude created.
	states?: Map<string, ProviderSessionState>;
	constructor(readonly id?: string) {}

	// OMP aborts the agent's own turn before it closes the agent's sessions, but
	// side requests share the agent's map and run on their callers' signals, so
	// whatever still runs here is aborted. Nothing writes state after this.
	close(): void {
		this.closed = true;
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

	endQuery(query: QueryContext, end: QueryEnd): void {
		this.queries.delete(query);
		if (!this.closed) this.state = stateAfterQuery(this.state, end);
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
