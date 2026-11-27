// OMP history rewrites: compaction, tree navigation and rewrites no hook
// reports. Run with `bun test`; see tests/harness/bridge.ts.
//

import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { join } from "node:path";
import type { CompactionPreparation } from "@oh-my-pi/pi-agent-core/compaction";
import {
	agent, assistant, claude, createdSince, emit, extensionContext, historyOf, resetHarness, run, sessionCalls, sessionState, text, transcriptOf, user,
	type Agent,
} from "./harness/bridge.ts";

afterEach(resetHarness);

async function turn(who: Agent, history: any[], prompt: string, reply: string) {
	claude.next(async function* (cc) { yield* cc.reply(reply); });
	const next = [...history, user(prompt)];
	next.push(await run(who, next));
	return next;
}

async function agentWithHistory(id: string) {
	const main = agent(id);
	const history = await turn(main, await turn(main, [], "hi", "hello"), "more", "sure");
	return { main, history, session: sessionState(main).sessionId };
}

test("an existing conversation keeps signed thinking from the old provider ID", async () => {
	const main = agent("renamed-provider");
	const answer = assistant("We picked the first option.");
	const prior = {
		...answer,
		api: "advanced-claude-bridge",
		provider: "advanced-claude-bridge",
		content: [{ type: "thinking", thinking: "Compare the options.", thinkingSignature: "old-signature" }, ...answer.content],
	};
	await turn(main, [user("Which option?"), prior], "Continue.", "Next step.");
	expect(transcriptOf(sessionState(main).sessionId)).toContain("assistant: thinking old-signature");
});

test("the compact hook summarizes in isolated queries and preserves earlier file operations", async () => {
	const preparation = {
		firstKeptEntryId: "keep",
		messagesToSummarize: [{ ...user("We migrated the parser."), role: "user" }],
		turnPrefixMessages: [], recentMessages: [], isSplitTurn: false, tokensBefore: 250,
		fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
		settings: { enabled: true, keepRecentTokens: 100, remoteEnabled: false },
	} satisfies CompactionPreparation;
	const event = { preparation, branchEntries: [{ type: "compaction", details: { readFiles: ["notes.md"], modifiedFiles: ["parser.ts"] } }], customInstructions: "Keep migration decisions." };
	const ctx = extensionContext();
	expect(await emit("session_before_compact", event, { ...ctx, model: { ...ctx.model, provider: "anthropic" } })).toEqual([undefined]);
	expect(claude.queries).toHaveLength(0);
	claude.next(async function* (cc) { yield* cc.reply("The parser migration is complete."); });
	claude.next(async function* (cc) { yield* cc.reply("Parser migration"); });
	expect(await emit("session_before_compact", event, ctx)).toEqual([{
		compaction: expect.objectContaining({ summary: expect.stringContaining("The parser migration is complete."), firstKeptEntryId: "keep", tokensBefore: 250,
			details: { readFiles: ["notes.md"], modifiedFiles: ["parser.ts"] } }),
	}]);
	expect(claude.queries[0].prompt).toContain("We migrated the parser.");
	expect(claude.queries[0].prompt).toContain("Keep migration decisions.");
	expect(claude.queries.every(({ options }) => options.persistSession === false && options.resume === undefined
		&& options.settings.autoMemoryEnabled === false && options.settings.outputStyle === "default")).toBe(true);
	expect(createdSince(0)).toEqual([]);
});

test("persisted provider mappings survive shutdown and OMP restarts", async () => {
	const main = agent(randomUUID());
	const ctx = extensionContext({ sessionId: main.sessionId });
	await emit("session_start", {}, ctx);
	const history = await turn(main, [], "persist", "answer");
	const session = sessionState(main).sessionId;
	const before = transcriptOf(session);
	const path = join(getAgentDir(), "claude-bridge", "sessions", `${main.sessionId}.json`);
	expect(readFileSync(path, "utf8")).toContain(session);
	expect(statSync(path).mode & 0o777).toBe(0o600);
	await emit("session_shutdown", {}, ctx);
	for (const state of main.states.values()) state.close();
	await emit("session_start", {}, ctx);
	claude.next(async function* (cc) { yield* cc.reply("resumed"); });
	await run(main, [...history, user("continue")]);
	expect(claude.queries.at(-1)!.options.resume).toBe(session);
	expect(transcriptOf(session)).not.toEqual(before);
});

test("primary branches persist independently, and corrupt mappings rebuild from OMP history", async () => {
	const main = agent(randomUUID());
	await emit("session_start", {}, extensionContext({ sessionId: main.sessionId }));
	const history = await turn(main, [], "one", "original");
	const original = sessionState(main).sessionId;
	const directory = join(getAgentDir(), "claude-bridge", "sessions");
	const mainMapping = join(directory, `${main.sessionId}.json`);
	const before = readFileSync(mainMapping, "utf8");
	const files = readdirSync(directory);
	await turn(agent(`${main.sessionId}:side:1`, main.states), history, "side", "side reply");
	await turn(agent(randomUUID()), history, "child", "child reply");
	expect(readdirSync(directory)).toEqual(files);
	expect(readFileSync(mainMapping, "utf8")).toBe(before);

	const branch = agent(randomUUID());
	await emit("session_branch", { reason: "fork" }, extensionContext({ sessionId: branch.sessionId }));
	const branchHistory = await turn(branch, history.slice(0, 1), "branch", "new reply");
	const fork = claude.queries.at(-1)!.options.resume;
	expect(fork).not.toBe(original);
	expect(transcriptOf(fork)).toEqual(historyOf(branchHistory));
	expect(transcriptOf(original)).toEqual(historyOf(history));
	expect(readFileSync(mainMapping, "utf8")).toBe(before);

	for (const state of branch.states.values()) state.close();
	writeFileSync(join(directory, `${branch.sessionId}.json`), "{ invalid");
	const rebuilt = await turn(branch, branchHistory, "continue", "recovered");
	const recovered = claude.queries.at(-1)!.options.resume;
	expect(recovered).not.toBe(fork);
	expect(transcriptOf(recovered)).toEqual(historyOf(rebuilt));
});

test("the full rendered prompt reaches Claude and prompt changes prevent native reuse", async () => {
	const main = agent("prompt-main");
	const system = ["OMP system rules", "Instruction added by an extension"];
	const first = user("hi");
	claude.next(async function* (cc) { yield* cc.reply("hello"); });
	const reply = await run(main, [first], {}, system);
	expect(claude.queries[0].options.systemPrompt).toEqual({
		type: "preset", preset: "claude_code", append: system.join("\n\n"),
	});
	expect(claude.queries[0].options.settings).toEqual({
		autoMemoryEnabled: false, outputStyle: "default", includeGitInstructions: false,
	});
	const original = claude.queries[0].sessionId;
	claude.next(async function* (cc) { yield* cc.reply("understood"); });
	const followUp = [first, reply, user("new rules")];
	followUp.push(await run(main, followUp, {}, [...system, "Updated AGENTS.md"]));
	const rebuilt = claude.queries[1].options.resume;
	expect(rebuilt).toBeDefined();
	expect(rebuilt).not.toBe(original);
	expect(claude.queries[1].options.systemPrompt.append).toBe([...system, "Updated AGENTS.md"].join("\n\n"));
	expect(transcriptOf(rebuilt)).toEqual(historyOf(followUp));
});

test("after compaction the next turn forks from its saved native transcript", async () => {
	const { main, session } = await agentWithHistory("compact-main");
	const old = transcriptOf(session)!;
	await emit("session_compact", { fromExtension: false });
	const after = await turn(main, [user("Summary: we said hello twice.")], "next", "ok");
	const fork = claude.queries.at(-1)!.options.resume;
	expect(fork).toBeDefined();
	expect(fork).not.toBe(session);
	expect(transcriptOf(session)).toEqual(old);
	expect(transcriptOf(fork!)).toEqual(historyOf(after));
});

test("tree navigation forks the selected native prefix", async () => {
	const { main, history, session } = await agentWithHistory("tree-main");
	const old = transcriptOf(session)!;
	await emit("session_tree");
	const after = await turn(main, history.slice(0, 2), "a different direction", "ok");
	const fork = claude.queries.at(-1)!.options.resume;
	expect(fork).toBeDefined();
	expect(fork).not.toBe(session);
	expect(transcriptOf(session)).toEqual(old);
	expect(transcriptOf(fork!)).toEqual(historyOf(after));
});

test("a turn after another provider forks from the unchanged native prefix", async () => {
	const { main, history, session } = await agentWithHistory("switch-main");
	const old = transcriptOf(session)!;
	const elsewhere = [...history, user("other model, please"), assistant("answer from another provider")];
	const after = await turn(main, elsewhere, "back to claude", "ok");
	const fork = claude.queries.at(-1)!.options.resume;
	expect(fork).toBeDefined();
	expect(fork).not.toBe(session);
	expect(transcriptOf(session)).toEqual(old);
	expect(transcriptOf(fork!)).toEqual(historyOf(after));
});

test.each(["edited", "removed"])("an %s final reply forks from the prior safe message", async change => {
	const { main, history, session } = await agentWithHistory(`reply-${change}`);
	const old = transcriptOf(session)!;
	const priors = history.slice(0, -1);
	if (change === "edited") priors.push({ ...history.at(-1), content: [{ type: "text", text: "replacement" }] });
	const after = await turn(main, priors, "next", "ok");
	const fork = claude.queries.at(-1)!.options.resume;
	expect(fork).not.toBe(session);
	expect(transcriptOf(session)).toEqual(old);
	expect(transcriptOf(fork!)).toEqual(historyOf(after));
});
test("compaction of one agent does not rewrite another agent's native transcript", async () => {
	const { main } = await agentWithHistory("compact-scope-main");
	const child = agent("compact-scope-child");
	const childHistory = await turn(child, [], "task", "working");
	const childSession = sessionState(child).sessionId;
	const old = transcriptOf(childSession);
	await emit("session_compact", { fromExtension: false });
	await turn(main, [user("Summary: hello.")], "next", "ok");
	const childNext = await turn(child, childHistory, "continue", "done");
	expect(claude.queries.at(-1)!.options.resume).toBe(childSession);
	expect(transcriptOf(childSession)).toEqual([...old!, ...historyOf(childNext.slice(-2))]);
});


test("an empty rebuild starts clean instead of resuming an unwritten session", async () => {
	const main = agent("empty-rebuild");
	claude.next(async function* (cc) { yield* cc.reply("hello"); });
	const reply = await run(main, [{ role: "developer", content: "   ", timestamp: 1 } as any, user("first turn")]);
	expect(text(reply)).toBe("hello");
	expect(claude.queries[0].options.resume).toBeUndefined();
	expect(sessionCalls).toEqual([]);
});

test("non-empty developer messages are forwarded in prompts and rebuilt history", async () => {
	const main = agent("developer-msg");
	claude.next(async function* (cc) { yield* cc.reply("acknowledged"); });
	const reply = await run(main, [
		{ role: "developer", content: "<system-reminder>project rule</system-reminder>", timestamp: 1 } as any,
		{ role: "developer", content: "continue now", timestamp: 2 } as any,
	]);
	expect(text(reply)).toBe("acknowledged");
	expect(claude.queries[0].prompt).toBe("continue now");
	expect(transcriptOf(claude.queries[0].options.resume)).toEqual(["user: <system-reminder>project rule</system-reminder>", "user: continue now", "assistant: acknowledged"]);
});

test("session-limit notices fail as quota/rate-limit errors instead of streaming as assistant text", async () => {
	const main = agent("session-limit");
	claude.next(async function* (cc) {
		yield { type: "system", subtype: "init", session_id: cc.sessionId };
		yield {
			type: "assistant",
			message: { id: "msg_limit", model: "<synthetic>", content: [{ type: "text", text: "You've hit your session limit · resets 5pm" }] },
		};
		yield { type: "result", subtype: "success", is_error: false, result: "" };
	});
	const reply = await run(main, [user("hello")]);
	expect(reply.stopReason).toBe("error");
	expect(reply.errorMessage).toContain("Claude quota exceeded — rate limit");
	expect(text(reply)).toBe("");
});
