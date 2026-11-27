// The AskClaude tool. Run with `bun test`; see tests/harness/bridge.ts.

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { z } from "zod";
import { loadConfig } from "../src/config.ts";
import { activateBridge, askClaudeTool, assistant, claude, createdSince, cwd, extensionContext, historyOf, resetHarness, transcriptOf, user } from "./harness/bridge.ts";

afterEach(resetHarness);

// AskClaude runs in the tool's process cwd, not the provider request's cwd.
const askCwd = process.cwd();

const otherModel = { id: "gpt-test", provider: "openai", api: "openai-responses" };

/** An OMP session branch as the session manager stores it. */
function branch(messages: any[]) {
	return messages.map((message, i) => ({
		type: "message", id: `entry-${i}`, parentId: i ? `entry-${i - 1}` : null, timestamp: new Date(message.timestamp).toISOString(), message,
	}));
}

function toolContext(sessionId: string, messages: any[], model: unknown = otherModel) {
	return extensionContext({
		model,
		getSystemPrompt: () => ["You are a test agent."],
		sessionManager: { getBranch: () => branch(messages), getSessionId: () => sessionId },
	});
}

function ask(params: Record<string, unknown>, ctx: unknown, signal?: AbortSignal) {
	return askClaudeTool().execute("call-1", params, signal, undefined, ctx);
}

test("loadConfig reads project configuration from claude-bridge.json", () => {
	const project = mkdtempSync(join(cwd, "config-"));
	try {
		const configDir = join(project, ".omp");
		mkdirSync(configDir);
		writeFileSync(join(configDir, "claude-bridge.json"), '{"askClaude":{"name":"DelegateToClaude"}}');
		expect(loadConfig(project).askClaude).toEqual({ name: "DelegateToClaude" });
	} finally {
		rmSync(project, { recursive: true, force: true });
	}
});

test("shared mode imports the conversation and resumes it", async () => {
	const history = [user("what does this repo do?"), assistant("It bridges Claude Code into OMP.")];
	claude.next(async function* (cc) {
		expect(transcriptOf(cc.query.sessionId, askCwd)).toEqual(historyOf(history));
		yield cc.query.assistant("msg_ask_shared", [{ type: "text", text: "It is an OMP extension." }], "end_turn");
	});
	const ctx = toolContext("ask-shared", history);
	const result = await ask({ prompt: "second opinion?" }, ctx);

	expect(result.details.error).toBeUndefined();
	expect(result.content[0].text).toBe("It is an OMP extension.");
	const query = claude.queries[0];
	expect(query.prompt).toBe("second opinion?");
	expect(query.options.resume).toBe(query.sessionId);
	expect(query.options.persistSession).toBe(false);
	expect(query.options.env.CLAUDE_CODE_ENTRYPOINT).toBe("omp-claude-bridge");
	expect(transcriptOf(query.sessionId, askCwd)).toBeNull();
	expect(query.options.settings).toEqual({ autoMemoryEnabled: false, outputStyle: "default" });
});

test("isolated mode starts a clean session and persists nothing", async () => {
	claude.next(async function* (cc) { yield* cc.reply("Fresh answer."); });
	const result = await ask(
		{ prompt: "fresh look", isolated: true },
		toolContext("ask-isolated", [user("earlier"), assistant("context")]),
	);

	expect(result.content[0].text).toBe("Fresh answer.");
	const query = claude.queries[0];
	expect(query.options.resume).toBeUndefined();
	expect(query.options.persistSession).toBe(false);
	expect(createdSince(0)).toEqual([]);
});

test("AskClaude refuses to run while its own provider is active", async () => {
	const ctx = toolContext("ask-circular", [user("hi")], extensionContext().model);
	const result = await ask({ prompt: "loop?" }, ctx);
	expect(result.details.error).toBe(true);
	expect(result.content[0].text).toContain("AskClaude cannot be used when the active provider is claude-bridge");
	expect(claude.queries).toHaveLength(0);
});

test.each([
	["full", false],
	["none", true],
] as const)("allowFullMode false handles the %s default and rejects explicit full mode", async (defaultMode, blocksRead) => {
	const project = mkdtempSync(join(cwd, "config-"));
	let tool: ReturnType<typeof askClaudeTool>;
	try {
		const configDir = join(project, ".omp");
		mkdirSync(configDir);
		writeFileSync(join(configDir, "claude-bridge.json"), JSON.stringify({ askClaude: { allowFullMode: false, defaultMode } }));
		const registration: Pick<ExtensionAPI, "zod" | "on" | "registerProvider" | "registerTool"> = {
			zod: z,
			on() {},
			registerProvider() {},
			registerTool(registered) { tool = registered; },
		};
		activateBridge(registration as ExtensionAPI, project);
	} finally {
		rmSync(project, { recursive: true, force: true });
	}

	const ctx = toolContext("ask-no-full", []);
	const denied = await tool.execute("call-full", { prompt: "test", mode: "full" }, undefined, undefined, ctx);
	expect(denied.details.error).toBe(true);
	expect(denied.content[0].text).toContain("full mode is disabled");
	expect(claude.queries).toHaveLength(0);

	claude.next(async function* (cc) { yield* cc.reply("Read-only answer."); });
	const result = await tool.execute("call-default", { prompt: "test", isolated: true }, undefined, undefined, ctx);
	expect(result.content[0].text).toBe("Read-only answer.");
	expect(claude.queries[0].options.disallowedTools).toContain("Write");
	expect(claude.queries[0].options.disallowedTools.includes("Read")).toBe(blocksRead);
});

test("AskClaude surfaces an SDK failure even after partial output", async () => {
	claude.next(async function* (cc) {
		yield* cc.reply("Partial answer.");
		yield { type: "result", subtype: "success", is_error: true, result: "Not authenticated" };
	});
	const result = await ask({ prompt: "test", isolated: true }, toolContext("ask-sdk-error", []));
	expect(result.details.error).toBe(true);
	expect(result.content[0].text).toBe("Error: Not authenticated");
	expect(claude.queries[0].isClosed).toBe(true);
});

test("a pre-aborted AskClaude call neither imports history nor starts a query", async () => {
	const result = await ask({ prompt: "test" }, toolContext("ask-pre-aborted", [user("earlier")]), AbortSignal.abort());
	expect(result.details.error).toBe(true);
	expect(result.content[0].text).toBe("Error: Aborted");
	expect(createdSince(0)).toEqual([]);
	expect(claude.queries).toHaveLength(0);
});
