// OMP history rewrites: compaction, tree navigation and rewrites no hook
// reports. Run with `bun test`; see tests/harness/bridge.ts.
//
// `test.failing` marks a known defect of port-baseline; the rewrite should
// turn each one into a plain `test`.

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CompactionPreparation } from "@oh-my-pi/pi-agent-core/compaction";
import {
	agent, assistant, claude, createdSince, cwd, emit, extensionContext, historyOf, resetHarness, run, sessionCalls, sessionState, text, transcriptOf, user,
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
		api: "claude-bridge",
		provider: "claude-bridge",
		content: [{ type: "thinking", thinking: "Compare the options.", thinkingSignature: "old-signature" }, ...answer.content],
	};
	await turn(main, [user("Which option?"), prior], "Continue.", "Next step.");
	expect(transcriptOf(sessionState(main).sessionId)).toContain("assistant: thinking old-signature");
});

test("the provider forwards instructions from the request project's nearest parent", async () => {
	const project = mkdtempSync(join(cwd, "instructions-"));
	try {
		const requestCwd = join(project, "nested");
		mkdirSync(requestCwd);
		writeFileSync(join(project, "AGENTS.md"), "Project rule: inspect this workspace first.\n");
		claude.next(async function* (cc) { yield* cc.reply("Understood."); });

		const reply = await run(agent("request-cwd"), [user("Read the project instructions.")], { cwd: requestCwd });
		expect(text(reply)).toBe("Understood.");
		expect(claude.queries[0].options.systemPrompt.append).toBe("# CLAUDE.md\n\nProject rule: inspect this workspace first.");
	} finally {
		rmSync(project, { recursive: true, force: true });
	}
});

test("the compact hook summarizes in isolated queries and preserves earlier file operations", async () => {
	const preparation = {
		firstKeptEntryId: "keep",
		messagesToSummarize: [{ ...user("We migrated the parser."), role: "user" }],
		turnPrefixMessages: [],
		recentMessages: [],
		isSplitTurn: false,
		tokensBefore: 250,
		fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
		settings: { enabled: true, keepRecentTokens: 100, remoteEnabled: false },
	} satisfies CompactionPreparation;
	const event = {
		preparation,
		branchEntries: [{ type: "compaction", details: { readFiles: ["notes.md"], modifiedFiles: ["parser.ts"] } }],
		customInstructions: "Keep migration decisions.",
	};
	const ctx = extensionContext();
	expect(await emit("session_before_compact", event, { ...ctx, model: { ...ctx.model, provider: "anthropic" } }))
		.toEqual([undefined]);
	expect(claude.queries).toHaveLength(0);

	claude.next(async function* (cc) { yield* cc.reply("The parser migration is complete."); });
	claude.next(async function* (cc) { yield* cc.reply("Parser migration"); });
	expect(await emit("session_before_compact", event, ctx)).toEqual([{
		compaction: expect.objectContaining({
			summary: expect.stringContaining("The parser migration is complete."),
			firstKeptEntryId: "keep",
			tokensBefore: 250,
			details: { readFiles: ["notes.md"], modifiedFiles: ["parser.ts"] },
		}),
	}]);
	expect(claude.queries[0].prompt).toContain("We migrated the parser.");
	expect(claude.queries[0].prompt).toContain("Keep migration decisions.");
	expect(claude.queries.every(({ options }) => options.persistSession === false && options.resume === undefined)).toBe(true);
	expect(createdSince(0)).toEqual([]);
});

test("after compaction the next turn rebuilds the session in place from the compacted history", async () => {
	const { main, session } = await agentWithHistory("compact-main");
	await emit("session_compact", { fromExtension: false });

	const mark = sessionCalls.length;
	const after = await turn(main, [user("Summary: we said hello twice.")], "next", "ok");
	expect(sessionCalls.slice(mark)).toEqual([
		{ op: "delete", sessionId: session },
		{ op: "create", sessionId: session, requestedId: session, records: 1 },
	]);
	expect(claude.queries.at(-1)!.options.resume).toBe(session);
	expect(transcriptOf(session)).toEqual(historyOf(after));
});

test("after tree navigation the next turn rebuilds the session from the selected branch", async () => {
	const { main, history, session } = await agentWithHistory("tree-main");
	await emit("session_tree");

	const mark = sessionCalls.length;
	const after = await turn(main, history.slice(0, 2), "a different direction", "ok");
	expect(createdSince(mark)).toEqual([{ op: "create", sessionId: session, requestedId: session, records: 2 }]);
	expect(claude.queries.at(-1)!.options.resume).toBe(session);
	expect(transcriptOf(session)).toEqual(historyOf(after));
});

test("a turn after another provider answered rebuilds the session with the missed messages", async () => {
	const { main, history, session } = await agentWithHistory("switch-main");
	const elsewhere = [...history, user("other model, please"), assistant("answer from another provider")];

	const mark = sessionCalls.length;
	const after = await turn(main, elsewhere, "back to claude", "ok");
	expect(createdSince(mark)).toEqual([{ op: "create", sessionId: session, requestedId: session, records: 6 }]);
	expect(transcriptOf(session)).toEqual(historyOf(after));
});

// port-baseline compared message counts. A rewrite that keeps the count and
// no hook reports looked like "nothing new", so the next turn resumed a
// session holding the old conversation.
test("a history rewrite no hook reports is detected by content", async () => {
	const { main, history } = await agentWithHistory("rewrite-main");
	const rewritten = [history[0], assistant("hello (edited)"), user("more (edited)"), history[3]];

	const after = await turn(main, rewritten, "next", "ok");
	const resume = claude.queries.at(-1)!.options.resume;
	expect(transcriptOf(resume)).toEqual(historyOf(after));
});

test.each(["edited", "removed"])("an %s final reply is not silently kept in the transcript", async (change) => {
	const { main, history, session } = await agentWithHistory(`reply-${change}`);
	const priors = history.slice(0, -1);
	if (change === "edited") {
		priors.push({ ...history.at(-1), content: [{ type: "text", text: "replacement" }] });
	}
	const after = await turn(main, priors, "next", "ok");
	expect(claude.queries.at(-1)!.options.resume).toBe(session);
	expect(transcriptOf(session)).toEqual(historyOf(after));
});

// port-baseline's hooks couldn't tell which session they belonged to, so a
// compaction in the main agent marked every live session for rebuild.
test("compaction in one session leaves other sessions' Claude Code sessions alone", async () => {
	const { main } = await agentWithHistory("compact-scope-main");
	const child = agent("compact-scope-child");
	const childHistory = await turn(child, [], "task", "working");
	const childSession = sessionState(child).sessionId;
	await emit("session_compact", { fromExtension: false });
	await turn(main, [user("Summary: hello.")], "next", "ok");

	const mark = sessionCalls.length;
	await turn(child, childHistory, "continue", "done");
	expect(claude.queries.at(-1)!.options.resume).toBe(childSession);
	expect(createdSince(mark)).toEqual([]);
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
