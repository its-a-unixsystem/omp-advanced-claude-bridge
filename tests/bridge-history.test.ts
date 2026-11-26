// OMP history rewrites: compaction, tree navigation and rewrites no hook
// reports. Run with `bun test`; see tests/harness/bridge.ts.
//
// `test.failing` marks a known defect of port-baseline; the rewrite should
// turn each one into a plain `test`.

import { afterEach, expect, test } from "bun:test";
import {
	agent, assistant, claude, createdSince, emit, historyOf, resetHarness, run, sessionCalls, sessionState, transcriptOf, user,
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
