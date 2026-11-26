// Claude Code session files for the harness.
//
// The bridge writes real JSONL files through cc-session-io into a temporary
// CLAUDE_CONFIG_DIR. The module mock wraps createSession and deleteSession so
// tests can see when the bridge rebuilt a session. The fake Claude Code uses
// `realIo` directly, so its own appends are not recorded as bridge calls.

import * as io from "cc-session-io";
import { existsSync } from "fs";
import { convertPiMessages } from "../../src/convert.ts";

// Copied at import time, before the harness replaces the module.
export const realIo = { ...io };

export type SessionCall =
	| { op: "create"; sessionId: string; requestedId?: string; records: number }
	| { op: "delete"; sessionId: string };

export const sessionCalls: SessionCall[] = [];

export function recordingSessionIo() {
	return {
		...realIo,
		createSession(opts: Parameters<typeof io.createSession>[0]) {
			const session = realIo.createSession(opts);
			const save = session.save.bind(session);
			session.save = () => {
				save();
				sessionCalls.push({ op: "create", sessionId: session.sessionId, requestedId: opts.sessionId, records: session.messages.length });
			};
			return session;
		},
		deleteSession(sessionId: string, projectPath: string, claudeDir?: string) {
			sessionCalls.push({ op: "delete", sessionId });
			realIo.deleteSession(sessionId, projectPath, claudeDir);
		},
	};
}

type Block = Record<string, any>;

function blockKeys(role: string, content: string | Block[]): string[] {
	if (typeof content === "string") return [`${role}: ${content}`];
	const keys: string[] = [];
	for (const block of content) {
		if (block.type === "text") keys.push(`${role}: ${block.text}`);
		else if (block.type === "thinking") keys.push(`${role}: thinking ${block.signature}`);
		else if (block.type === "tool_use") keys.push(`${role}: tool_use ${block.id}`);
		else if (block.type === "tool_result") keys.push(`${role}: tool_result ${block.tool_use_id}`);
		else if (block.type === "image") keys.push(`${role}: image`);
	}
	return keys;
}

/** The conversation stored in a Claude Code session file, one line per block. */
export function transcript(sessionId: string, cwd: string): string[] | null {
	const path = realIo.getSessionPath(sessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
	if (!existsSync(path)) return null;
	const session = realIo.readSession(path, cwd);
	return session.messages.flatMap((record) => blockKeys(record.message.role, record.message.content as string | Block[]));
}

/** What a session must contain to match OMP's history, in `transcript` form. */
export function expectedTranscript(messages: unknown[]): string[] {
	const { anthropicMessages } = convertPiMessages(messages as any);
	return realIo.repairToolPairing(anthropicMessages).flatMap((m) => blockKeys(m.role, m.content as string | Block[]));
}
