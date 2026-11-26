// Request classification: what a provider request asks the bridge to do.
//
// Decided once per request, from the messages it carries and the session it
// owns (see bridgeSession). Nothing outside that session is consulted, so a busy
// query in another session never changes how a request is handled.
//
// Extracted from index.ts so tests can import without activating the extension.

import type { Message } from "@oh-my-pi/pi-ai";
import { isPromptRole } from "./convert.js";
import { extractAllToolResults, type McpResult } from "./extract-tool-results.js";

export interface ToolCallOwner {
	ownsToolCall(id: string): boolean;
}

export type RequestKind<Q> =
	// Results for tool calls a running query of this session is waiting on.
	// `steer` is set when OMP appended a user message after the results.
	| { kind: "tool-results"; query: Q; results: McpResult[]; steer: boolean }
	// A tool result whose query is gone (aborted or ended).
	| { kind: "orphaned-result" }
	// A request that owns no session: an OMP helper reusing the agent's
	// sessionId without its providerSessionState.
	| { kind: "helper" }
	// The agent's next turn. Whether it resumes the session is syncSession's call.
	| { kind: "turn" };

export function classifyRequest<Q extends ToolCallOwner>(
	messages: Message[],
	session: { queries: Iterable<Q> } | null,
): RequestKind<Q> {
	const lastRole = messages[messages.length - 1]?.role;
	if (session) {
		const { results } = extractAllToolResults(messages as unknown as Parameters<typeof extractAllToolResults>[0]);
		const ids = results.map((r) => r.toolCallId).filter((id): id is string => Boolean(id));
		for (const query of session.queries) {
			if (ids.some((id) => query.ownsToolCall(id))) {
				return { kind: "tool-results", query, results, steer: lastRole !== undefined && isPromptRole(lastRole) };
			}
		}
	}
	if (lastRole === "toolResult") return { kind: "orphaned-result" };
	return session ? { kind: "turn" } : { kind: "helper" };
}
