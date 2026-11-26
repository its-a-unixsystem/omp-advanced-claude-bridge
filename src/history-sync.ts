// History sync: does a Claude Code session still hold the history OMP sends?
//
// A session's sync state names the OMP messages its Claude Code session holds:
// the first `cursor` messages of the history, fingerprinted by `prefix`. Each
// message is hashed by its role and content, so an OMP rewrite that keeps the
// message count (an edit, a pruned tool output, a compaction no hook reports)
// still changes the fingerprint. Timestamps, usage and other metadata OMP adds
// or drops between requests are left out.
//
// Claude Code already has the bridge's last reply, even though it wasn't in
// the request. Resume only if OMP includes that same reply, unchanged.
//
// Extracted from index.ts so tests can import without activating the extension.

import { createHash } from "node:crypto";
import type { SessionState } from "./bridge-session.js";

export interface SyncedHistory {
	cursor: number;
	prefix: string;
}

interface HistoryMessage {
	role: string;
	content?: unknown;
	toolCallId?: string;
	isError?: boolean;
	timestamp?: number;
}

export type SyncPlan = {
	// The whole request, prompt included: what the session holds once the query
	// has sent the prompt.
	request: SyncedHistory;
} & (
	// The history before the prompt continues the synced one.
	| { path: "reuse"; priors: SyncedHistory; adoptedReply: boolean }
	// Nothing before the prompt: start without resuming.
	| { path: "clean-start" }
	// Write the history before the prompt into the session.
	| { path: "rebuild"; priors: SyncedHistory; reason: "first" | "flagged" | "diverged" }
);

function messageDigest(message: HistoryMessage): string {
	const hash = createHash("sha1");
	hash.update(message.role);
	hash.update("\0");
	if (message.role === "toolResult") hash.update(`${message.toolCallId ?? ""}\0${message.isError ? 1 : 0}\0`);
	hash.update(JSON.stringify(message.content ?? null));
	return hash.digest("hex");
}

export function replyIdentity(message: HistoryMessage & { timestamp: number }): NonNullable<SessionState["reply"]> {
	return { timestamp: message.timestamp, digest: messageDigest(message) };
}

function chain(digests: string[], count: number): SyncedHistory {
	const hash = createHash("sha1");
	for (let i = 0; i < count; i++) hash.update(digests[i]);
	return { cursor: count, prefix: hash.digest("hex") };
}

export function historyFingerprint(messages: readonly HistoryMessage[]): SyncedHistory {
	return chain(messages.map(messageDigest), messages.length);
}

export function planSync(state: SessionState | null, messages: readonly HistoryMessage[]): SyncPlan {
	const digests = messages.map(messageDigest);
	const request = chain(digests, digests.length);
	const priorCount = Math.max(digests.length - 1, 0);
	const priors = () => chain(digests, priorCount);

	if (state && !state.needsRebuild && priorCount >= state.cursor && chain(digests, state.cursor).prefix === state.prefix) {
		if (priorCount === state.cursor && !state.reply) return { path: "reuse", request, priors: priors(), adoptedReply: false };
		const next = messages[state.cursor];
		if (priorCount === state.cursor + 1 && next.role === "assistant" && state.reply
			&& next.timestamp === state.reply.timestamp && digests[state.cursor] === state.reply.digest) {
			return { path: "reuse", request, priors: priors(), adoptedReply: true };
		}
	}
	if (priorCount === 0) return { path: "clean-start", request };
	const reason = !state ? "first" : state.needsRebuild ? "flagged" : "diverged";
	return { path: "rebuild", request, priors: priors(), reason };
}
