// Loads src/index.ts under bun with a fake Claude Agent SDK and recorded
// cc-session-io calls, and registers it against a fake OMP extension API.
//
// The bridge module is loaded once per process, like in OMP, so module-level
// state carries over between tests. Each test uses its own session ids and
// calls resetHarness() afterwards.

import { mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { z } from "zod";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { FakeClaude, createSdkMcpServer } from "./fake-claude.ts";
import { expectedTranscript, recordingSessionIo, sessionCalls, transcript } from "./session-files.ts";

const root = mkdtempSync(join(tmpdir(), "claude-bridge-test-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
// HOME keeps the user's config, AGENTS.md and diagnostic log out of the tests.
process.env.HOME = join(root, "home");
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
// Debug logs only when a test run asks for them with CLAUDE_BRIDGE_DEBUG_PATH.
if (!process.env.CLAUDE_BRIDGE_DEBUG_PATH) delete process.env.CLAUDE_BRIDGE_DEBUG;
export const cwd = join(root, "project");
for (const dir of [process.env.HOME, process.env.CLAUDE_CONFIG_DIR, cwd]) mkdirSync(dir, { recursive: true });

export const claude = new FakeClaude();

mock.module("@anthropic-ai/claude-agent-sdk", () => ({ query: claude.query, createSdkMcpServer }));
mock.module("cc-session-io", () => recordingSessionIo());

const { default: activate } = await import("../../src/index.ts");
export function activateBridge(api: ExtensionAPI, project = cwd): void {
	const previous = process.cwd();
	process.chdir(project);
	try {
		activate(api);
	} finally {
		process.chdir(previous);
	}
}

type Handler = (event: any, ctx: any) => unknown;
const handlers = new Map<string, Handler[]>();
const tools = new Map<string, any>();
const providers = new Map<string, any>();

export const notices: Array<{ message: string; level?: string }> = [];
const ui = { notify: (message: string, level?: string) => notices.push({ message, level }) };

activateBridge({
	on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
	registerProvider: (id: string, config: unknown) => providers.set(id, config),
	registerTool: (tool: any) => tools.set(tool.name, tool),
	zod: z,
} as any);

export const PROVIDER_ID = "advanced-claude-bridge";
const provider = providers.get(PROVIDER_ID);

const registered = provider.models.find((m: any) => m.id.includes("sonnet")) ?? provider.models[0];
export const model = { ...registered, api: PROVIDER_ID, provider: PROVIDER_ID, baseUrl: provider.baseUrl };

export function extensionContext(overrides: Record<string, unknown> = {}) {
	return { agent: { kind: "main" }, ui, model, ...overrides };
}

/** Fire an OMP extension event at the bridge's handlers. */
export async function emit(event: string, payload: Record<string, unknown> = {}, ctx = extensionContext()): Promise<unknown[]> {
	const results = [];
	for (const handler of handlers.get(event) ?? []) results.push(await handler({ type: event, ...payload }, ctx));
	return results;
}

export function askClaudeTool() {
	return tools.get("AskClaudeAdvanced");
}

await emit("session_start");

// --- Requests ---

export interface Agent {
	sessionId: string;
	states: Map<string, any>;
}

/** An OMP agent session: provider sessionId plus its providerSessionState map. */
export function agent(sessionId: string, states = new Map<string, any>()): Agent {
	return { sessionId, states };
}

export function stream(who: Agent, messages: any[], extra: Record<string, unknown> = {}) {
	return provider.streamSimple(model, { systemPrompt: ["You are a test agent."], messages, tools: TOOLS }, {
		sessionId: who.sessionId,
		providerSessionState: who.states,
		cwd,
		...extra,
	});
}

/** One provider request, finished the way OMP finishes it: the agent loop
 *  does other async work before its next request, so let the bridge settle. */
export async function run(who: Agent, messages: any[], extra: Record<string, unknown> = {}) {
	const result = await stream(who, messages, extra).result();
	await settle();
	return result;
}

/** The bridge's state for a provider sessionId, as stored in the agent's map. */
export function sessionState(who: Agent) {
	return who.states.get(`${PROVIDER_ID}:${who.sessionId}`)?.state ?? null;
}

// --- Messages ---

const TOOLS = [
	{ name: "task", description: "Run a subagent", parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } },
	{ name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
];

let clock = Date.now();

export function user(text: string) {
	return { role: "user", content: text, timestamp: clock++ };
}

export function assistant(text: string) {
	return {
		role: "assistant", content: [{ type: "text", text }],
		api: PROVIDER_ID, provider: PROVIDER_ID, model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: clock++,
	};
}

export function toolResult(toolCallId: string, text: string, toolName = "bash") {
	return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp: clock++ };
}

export function text(message: any): string {
	return message.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
}

// --- Session files ---

export { sessionCalls };

export function transcriptOf(sessionId: string, projectPath = cwd) {
	return transcript(sessionId, projectPath);
}

/** The transcript a resumed session must have so Claude sees OMP's history. */
export function historyOf(messages: any[]) {
	return expectedTranscript(messages);
}

/** Rebuilds (createSession saves) recorded since the given index. */
export function createdSince(index: number) {
	return sessionCalls.slice(index).filter((c) => c.op === "create");
}

// --- Lifecycle ---

/** Let queued microtasks and promise callbacks run. */
export async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

export async function resetHarness(): Promise<void> {
	await settle();
	// A failed expectation can leave a query waiting on a tool result. Close it
	// so the bridge finishes it before the next test.
	for (const q of claude.queries) if (!q.isClosed) q.close();
	await settle();
	await emit("session_shutdown");
	await emit("session_start");
	claude.reset();
	sessionCalls.length = 0;
	notices.length = 0;
}
