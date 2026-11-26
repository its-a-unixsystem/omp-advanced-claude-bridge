// The AskClaude tool. Run with `bun test`; see tests/harness/bridge.ts.

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { askClaudeTool, assistant, claude, createdSince, cwd, extensionContext, historyOf, resetHarness, transcriptOf, user } from "./harness/bridge.ts";

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

function ask(params: Record<string, unknown>, ctx: unknown) {
	return askClaudeTool().execute("call-1", params, undefined, undefined, ctx);
}

test("the fork reads only its own project configuration", () => {
	const project = mkdtempSync(join(cwd, "config-"));
	try {
		const configDir = join(project, ".omp");
		mkdirSync(configDir);
		writeFileSync(join(configDir, "claude-bridge.json"), '{"askClaude":{"enabled":false}}');
		expect(loadConfig(project).askClaude?.enabled).toBeUndefined();

		writeFileSync(join(configDir, "advanced-claude-bridge.json"), '{"askClaude":{"name":"DelegateToClaude"}}');
		expect(loadConfig(project).askClaude).toEqual({ name: "DelegateToClaude" });
	} finally {
		rmSync(project, { recursive: true, force: true });
	}
});

test("shared mode imports the conversation and resumes it", async () => {
	const history = [user("what does this repo do?"), assistant("It bridges Claude Code into OMP.")];
	claude.next(async function* (cc) {
		yield cc.query.assistant("msg_ask_shared", [{ type: "text", text: "It is an OMP extension." }], "end_turn");
	});
	const result = await ask({ prompt: "second opinion?" }, toolContext("ask-shared", history));

	expect(result.details.error).toBeUndefined();
	expect(result.content[0].text).toBe("It is an OMP extension.");
	const created = createdSince(0);
	expect(created).toHaveLength(1);
	const query = claude.queries[0];
	expect(query.prompt).toBe("second opinion?");
	expect(query.options.resume).toBe(created[0].sessionId);
	expect(query.options.disallowedTools).toContain("Write");
	expect(transcriptOf(created[0].sessionId, askCwd)).toEqual(
		historyOf([...history, user("second opinion?"), assistant("It is an OMP extension.")]),
	);
});

test("isolated mode works from the upstream provider and persists nothing", async () => {
	claude.next(async function* (cc) { yield* cc.reply("Fresh answer."); });
	const upstreamModel = { ...extensionContext().model, provider: "claude-bridge", api: "claude-bridge" };
	const result = await ask(
		{ prompt: "fresh look", isolated: true },
		toolContext("ask-isolated", [user("earlier"), assistant("context")], upstreamModel),
	);

	expect(result.content[0].text).toBe("Fresh answer.");
	const query = claude.queries[0];
	expect(query.options.resume).toBeUndefined();
	expect(query.options.persistSession).toBe(false);
	expect(createdSince(0)).toEqual([]);
});

test("AskClaudeAdvanced refuses to run while its own provider is active", async () => {
	const ctx = toolContext("ask-circular", [user("hi")], extensionContext().model);
	const result = await ask({ prompt: "loop?" }, ctx);
	expect(result.details.error).toBe(true);
	expect(result.content[0].text).toContain("AskClaudeAdvanced cannot be used when the active provider is advanced-claude-bridge");
	expect(claude.queries).toHaveLength(0);
});
