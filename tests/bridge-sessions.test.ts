// Who owns which Claude Code session: main agents, subagents, side requests
// and helper requests. Run with `bun test`; see tests/harness/bridge.ts.
//
// `test.failing` marks a known defect of port-baseline (listed in
// documentation/in-progress/2026-11-26_session-core-rewrite.md). The rewrite
// should turn each one into a plain `test`.

import { afterEach, describe, expect, test } from "bun:test";
import {
	agent, assistant, claude, createdSince, emit, historyOf, resetHarness, run, sessionCalls, sessionState, settle, stream, text,
	toolResult, transcriptOf, user, type Agent,
} from "./harness/bridge.ts";

afterEach(resetHarness);

/** Run one plain turn for `who` and return the history including the reply. */
async function turn(who: Agent, history: any[], prompt: string, reply: string) {
	claude.next(async function* (cc) { yield* cc.reply(reply); });
	const next = [...history, user(prompt)];
	next.push(await run(who, next));
	return next;
}

/** Start a turn that calls the `task` tool and stops while the tool runs. */
async function startTaskTurn(who: Agent, history: any[], toolUseId: string) {
	claude.next(async function* (cc) {
		const result = yield* cc.useTool(toolUseId, "task", { prompt: "look around" });
		yield* cc.reply(`task said: ${text(result)}`);
	});
	const next = [...history, user("delegate this")];
	const toolUse = await run(who, next);
	expect(toolUse.stopReason).toBe("toolUse");
	return [...next, toolUse];
}

describe("main agent", () => {
	test("the first turn starts a Claude Code session and the next turn resumes it", async () => {
		const main = agent("turns-main");
		const first = await turn(main, [], "hi", "hello");
		expect(claude.queries[0].options.resume).toBeUndefined();
		const ccSession = claude.queries[0].sessionId;
		expect(sessionState(main)).toMatchObject({ sessionId: ccSession, cursor: 1 });

		const mark = sessionCalls.length;
		const second = await turn(main, first, "more", "sure");
		expect(claude.queries[1].options.resume).toBe(ccSession);
		expect(createdSince(mark)).toEqual([]);
		expect(transcriptOf(ccSession)).toEqual(historyOf(second));
	});

	test("history from another provider is imported before the first turn", async () => {
		const main = agent("import-main");
		const history = await turn(main, [user("earlier"), assistant("from another model")], "now you", "ok");
		const created = createdSince(0);
		expect(created).toHaveLength(1);
		expect(created[0].records).toBe(2);
		expect(claude.queries[0].options.resume).toBe(created[0].sessionId);
		expect(transcriptOf(created[0].sessionId)).toEqual(historyOf(history));
	});

	test("a tool call goes out through the MCP server and its result comes back", async () => {
		const main = agent("tool-main");
		const history = await startTaskTurn(main, [], "toolu_task");
		expect(history.at(-1).content).toEqual([
			{ type: "toolCall", id: "toolu_task", name: "task", arguments: { prompt: "look around" } },
		]);
		expect(claude.queries[0].options.mcpServers["advanced-claude-bridge-tools"]?.name).toBe("advanced-claude-bridge-tools");
		history.push(toolResult("toolu_task", "found it", "task"));
		const reply = await run(main, history);
		expect(text(reply)).toBe("task said: found it");
		history.push(reply);
		expect(sessionState(main).cursor).toBe(3);
		expect(transcriptOf(claude.queries[0].sessionId)).toEqual(historyOf(history));
		expect(claude.queries[0].isClosed).toBe(true);
	});
});

describe("subagents", () => {
	test("a subagent imports its own history and keeps its own cursor", async () => {
		const main = agent("child-main");
		const child = agent("child-sub");
		let mainHistory = await turn(main, [], "hi", "hello");
		const mainSession = sessionState(main).sessionId;
		mainHistory = await startTaskTurn(main, mainHistory, "toolu_task");
		const mainWhileWaiting = { ...sessionState(main) };

		const mark = sessionCalls.length;
		const childHistory = await turn(child, [user("task: look around"), assistant("Looking.")], "continue", "found it");
		const created = createdSince(mark);
		expect(created).toHaveLength(1);
		expect(created[0].records).toBe(2);
		const childQuery = claude.queries.at(-1)!;
		expect(childQuery.options.resume).toBe(created[0].sessionId);
		expect(sessionState(child)).toMatchObject({ sessionId: created[0].sessionId, cursor: 3 });
		expect(transcriptOf(created[0].sessionId)).toEqual(historyOf(childHistory));
		expect(sessionState(main)).toEqual(mainWhileWaiting);
		expect([...child.states.keys()]).toEqual(["advanced-claude-bridge:child-sub"]);
		expect([...main.states.keys()]).toEqual(["advanced-claude-bridge:child-main"]);

		mainHistory.push(toolResult("toolu_task", "found it", "task"));
		const reply = await run(main, mainHistory);
		expect(text(reply)).toBe("task said: found it");
		mainHistory.push(reply);
		expect(sessionState(main)).toMatchObject({ sessionId: mainSession, cursor: 5 });
		expect(transcriptOf(mainSession)).toEqual(historyOf(mainHistory));
	});
});

describe("side requests", () => {
	test("a side request gets its own session and leaves the main one alone", async () => {
		const main = agent("side-main");
		const mainHistory = await turn(main, await turn(main, [], "hi", "hello"), "more", "sure");
		const mainSession = sessionState(main).sessionId;
		const mainBefore = { ...sessionState(main) };

		const side = agent("side-main:side:1", main.states);
		await turn(side, mainHistory, "btw, what is 2+2?", "4");
		const sideQuery = claude.queries.at(-1)!;
		expect(sideQuery.options.resume).toBeDefined();
		expect(sideQuery.options.resume).not.toBe(mainSession);
		expect(sessionState(side).sessionId).toBe(sideQuery.options.resume);
		expect(sessionState(main)).toEqual(mainBefore);
		expect(transcriptOf(mainSession)).toEqual(historyOf(mainHistory));

		const mark = sessionCalls.length;
		await turn(main, mainHistory, "continue", "ok");
		expect(claude.queries.at(-1)!.options.resume).toBe(mainSession);
		expect(createdSince(mark)).toEqual([]);
	});

	test("a side request while the main agent waits for a tool leaves the main turn intact", async () => {
		const main = agent("side-busy-main");
		const mainHistory = await startTaskTurn(main, await turn(main, [], "hi", "hello"), "toolu_task");
		const mainSession = sessionState(main).sessionId;
		const mainBefore = { ...sessionState(main) };

		const side = agent("side-busy-main:side:1", main.states);
		await turn(side, mainHistory.slice(0, 2), "btw?", "yes");
		expect(sessionState(main)).toEqual(mainBefore);

		mainHistory.push(toolResult("toolu_task", "done", "task"));
		const reply = await run(main, mainHistory);
		expect(text(reply)).toBe("task said: done");
		mainHistory.push(reply);
		expect(sessionState(main)).toMatchObject({ sessionId: mainSession, cursor: 5 });
		expect(transcriptOf(mainSession)).toEqual(historyOf(mainHistory));
	});
});

describe("helper requests that reuse the agent's sessionId", () => {
	// OMP helpers (judges, the title model, auto-repair) send their own short
	// context under the agent's provider sessionId, without its
	// providerSessionState.
	const asHelper = { providerSessionState: undefined };

	async function agentWithHistory(id: string) {
		const main = agent(id);
		const history = await turn(main, await turn(main, [], "hi", "hello"), "more", "sure");
		return { main, history, session: sessionState(main).sessionId, before: { ...sessionState(main) } };
	}

	test("a completed helper leaves the agent's session alone and deletes its own", async () => {
		const { main, history, session, before } = await agentWithHistory("helper-done");
		claude.next(async function* (cc) { yield* cc.reply("A title"); });
		const reply = await run(main, [user("Write a title for this conversation")], asHelper);
		expect(text(reply)).toBe("A title");
		const helperQuery = claude.queries.at(-1)!;
		expect(helperQuery.options.resume).toBeUndefined();
		expect(sessionState(main)).toEqual(before);
		expect(sessionCalls).toContainEqual({ op: "delete", sessionId: helperQuery.sessionId });
		expect(transcriptOf(helperQuery.sessionId)).toBeNull();

		const mark = sessionCalls.length;
		await turn(main, history, "continue", "ok");
		expect(claude.queries.at(-1)!.options.resume).toBe(session);
		expect(createdSince(mark)).toEqual([]);
	});

	test("an aborted helper leaves the agent's session alone", async () => {
		const { main, before } = await agentWithHistory("helper-abort");
		claude.next(async function* (cc) { await cc.closed(); });
		const controller = new AbortController();
		const pending = stream(main, [user("Write a title")], { ...asHelper, signal: controller.signal });
		await claude.waitForQueries(3);
		await settle();
		controller.abort();
		const reply = await pending.result();
		expect(reply.stopReason).toBe("aborted");
		expect(claude.queries.at(-1)!.isClosed).toBe(true);
		await settle();
		expect(sessionState(main)).toEqual(before);
	});

	// port-baseline's abort branch returned before the ephemeral session was
	// deleted, so every aborted helper left a session file behind.
	test("an aborted helper leaves no session file behind", async () => {
		const { main } = await agentWithHistory("helper-abort-leak");
		claude.next(async function* (cc) { await cc.closed(); });
		const controller = new AbortController();
		const pending = stream(main, [user("Write a title")], { ...asHelper, signal: controller.signal });
		await claude.waitForQueries(3);
		await settle();
		controller.abort();
		await pending.result();
		await settle();
		expect(transcriptOf(claude.queries.at(-1)!.sessionId)).toBeNull();
	});

	// Judges retry with a forced SUBMIT_JUDGMENT tool call and read it from the
	// final message; no tool result ever comes back. A request without a
	// session can't receive one anyway, so its tool-use turn is its last.
	test("a helper's tool call ends its query and deletes its session", async () => {
		const { main, before } = await agentWithHistory("helper-tool");
		claude.next(async function* (cc) {
			yield* cc.useTool("toolu_judge", "bash", { command: "judge" });
			yield* cc.reply("never");
		});
		const reply = await run(main, [user("Judge this")], asHelper);
		expect(reply.stopReason).toBe("toolUse");
		expect(reply.content).toMatchObject([{ type: "toolCall", id: "toolu_judge", name: "bash" }]);
		const helperQuery = claude.queries.at(-1)!;
		expect(helperQuery.isClosed).toBe(true);
		expect(sessionCalls).toContainEqual({ op: "delete", sessionId: helperQuery.sessionId });
		expect(transcriptOf(helperQuery.sessionId)).toBeNull();
		expect(sessionState(main)).toEqual(before);
	});

	test("a failed helper leaves the agent's session alone", async () => {
		const { main, before } = await agentWithHistory("helper-error");
		claude.next(async function* () { throw new Error("helper exploded"); });
		const reply = await run(main, [user("Write a title")], asHelper);
		expect(reply.stopReason).toBe("error");
		expect(reply.errorMessage).toContain("helper exploded");
		expect(sessionState(main)).toEqual(before);
	});

	// No OMP 19.2.1 helper sends the agent's history under its sessionId with
	// the agent's providerSessionState, but if one did, it would run as the
	// agent's turn and append its own exchange to the agent's session.
	// port-baseline then took the agent's next turn for a helper and ran it
	// without any history. Now that turn sees its history diverge from the
	// synced one and rebuilds the session without the helper's exchange.
	test("a helper with a longer context does not take over the agent's session", async () => {
		const { main, history, session } = await agentWithHistory("helper-longer");
		claude.next(async function* (cc) { yield* cc.reply("Looks fine."); });
		await run(main, [...history, user("Advisor: review the conversation so far")]);

		const next = [...history, user("continue")];
		claude.next(async function* (cc) { yield* cc.reply("ok"); });
		next.push(await run(main, next));
		expect(claude.queries.at(-1)!.options.resume).toBe(session);
		expect(transcriptOf(session)).toEqual(historyOf(next));
	});
});

describe("session lifecycle", () => {
	// What OMP does on dispose, new, fresh, switched or reloaded sessions.
	function closeAll(states: Map<string, any>) {
		for (const state of states.values()) state.close();
		states.clear();
	}

	// OMP aborts the agent's own turn before closing its sessions, but side
	// requests share the agent's map and run on their callers' signals.
	test("closing a session stops its running query", async () => {
		const main = agent("close-running");
		await turn(main, [], "hi", "hello");
		const side = agent("close-running:side:1", main.states);
		claude.next(async function* (cc) { await cc.closed(); });
		const pending = stream(side, [user("btw?")]);
		await claude.waitForQueries(2);
		await settle();
		const sideSession = side.states.get(`advanced-claude-bridge:${side.sessionId}`);

		closeAll(main.states);
		await settle();
		const query = claude.queries[1];
		expect(query.interruptCalls).toBeGreaterThan(0);
		expect(query.isClosed).toBe(true);
		expect((await pending.result()).stopReason).toBe("aborted");
		expect(sideSession.state).toBeNull();
		expect(sideSession.queries.size).toBe(0);
	});

	// port-baseline let the query run on after close() and wrote its sync state
	// into the closed session when it finished.
	test("a query running when its session closes writes nothing into it", async () => {
		const main = agent("close-then-finish");
		await turn(main, [], "hi", "hello");
		const session = main.states.get(`advanced-claude-bridge:${main.sessionId}`);
		const go = Promise.withResolvers<void>();
		claude.next(async function* (cc) {
			await go.promise;
			yield* cc.reply("late");
		});
		const pending = stream(main, [user("hi"), assistant("hello"), user("long task")]);
		await claude.waitForQueries(2);
		await settle();

		closeAll(main.states);
		go.resolve();
		await Promise.race([pending.result(), settle()]);
		await settle();
		expect(session.state).toBeNull();
	});

	// OMP's own order for the agent's turn: abort, then close. The cleanup that
	// runs once Claude Code exits must not bring the state back.
	test("an aborted query writes nothing into a session closed before its cleanup", async () => {
		const main = agent("close-after-abort");
		await turn(main, [], "hi", "hello");
		const session = main.states.get(`advanced-claude-bridge:${main.sessionId}`);
		claude.next(async function* (cc) { await cc.closed(); });
		const controller = new AbortController();
		const pending = stream(main, [user("hi"), assistant("hello"), user("long task")], { signal: controller.signal });
		await claude.waitForQueries(2);
		await settle();
		const exit = claude.queries[1].holdExit();

		controller.abort();
		closeAll(main.states);
		exit();
		expect((await pending.result()).stopReason).toBe("aborted");
		await settle();
		expect(session.state).toBeNull();
	});

	// OMP's dispose emits session_shutdown before it aborts the agent's turn
	// with the reason it records for an interrupted turn. Closing the session
	// there would abort the query first, under the bridge's own message.
	test("main shutdown leaves the agent's running turn to OMP", async () => {
		const main = agent("shutdown-running");
		claude.next(async function* (cc) { await cc.closed(); });
		const controller = new AbortController();
		const pending = stream(main, [user("long task")], { signal: controller.signal });
		await claude.waitForQueries(1);
		await settle();

		await emit("session_shutdown");
		await settle();
		expect(claude.queries[0].isClosed).toBe(false);
		controller.abort();
		closeAll(main.states);
		expect((await pending.result()).stopReason).toBe("aborted");
		await emit("session_start");
	});

	// OMP calls releaseSession(sideSessionId) on every entry of the agent's map
	// when a side request ends. A side request that called a tool never gets
	// its result: OMP takes the tool-use message as the answer.
	test("releasing a side request stops its query and forgets its session", async () => {
		const main = agent("release-side");
		const mainHistory = await turn(main, [], "hi", "hello");
		const mainBefore = { ...sessionState(main) };
		const side = agent("release-side:side:1", main.states);
		claude.next(async function* (cc) {
			yield* cc.useTool("toolu_side", "bash", { command: "ls" });
			yield* cc.reply("never");
		});
		const reply = await run(side, [...mainHistory, user("btw, what's here?")]);
		expect(reply.stopReason).toBe("toolUse");
		const sideQuery = claude.queries[1];
		expect(sideQuery.isClosed).toBe(false);

		for (const state of [...main.states.values()]) state.releaseSession?.(side.sessionId);
		await settle();
		expect(sideQuery.isClosed).toBe(true);
		expect([...main.states.keys()]).toEqual(["advanced-claude-bridge:release-side"]);
		expect(sessionState(main)).toEqual(mainBefore);

		const mark = sessionCalls.length;
		await turn(main, mainHistory, "continue", "ok");
		expect(claude.queries.at(-1)!.options.resume).toBe(mainBefore.sessionId);
		expect(createdSince(mark)).toEqual([]);
	});
});

describe("process-wide query state", () => {
	// port-baseline reset one top-level QueryContext on an orphaned tool
	// result, and that context belonged to whichever session started its
	// query while nothing else ran.
	test("an orphaned tool result in one session leaves another session's turn alone", async () => {
		const busy = agent("orphan-busy");
		const other = agent("orphan-other");
		const reached = Promise.withResolvers<void>();
		const go = Promise.withResolvers<void>();
		claude.next(async function* (cc) {
			const replies = cc.reply("complete answer");
			for (let i = 0; i < 3; i++) yield (await replies.next()).value;
			reached.resolve();
			await go.promise;
			yield* replies;
		});
		const pending = stream(busy, [user("hi")]);
		await reached.promise;
		await settle();

		const orphan = await run(other, [user("run it"), { ...assistant(""), content: [{ type: "toolCall", id: "toolu_gone", name: "bash", arguments: {} }] }, toolResult("toolu_gone", "aborted")]);
		expect(orphan.stopReason).toBe("stop");

		go.resolve();
		expect(text(await pending.result())).toBe("complete answer");
	});

	// port-baseline reused one top-level QueryContext for consecutive queries.
	// The first query's cleanup ran after its stream completed and removed the
	// shared context from the active set, so a tool result for a turn that
	// started before that cleanup was treated as orphaned and its MCP handler
	// never resolved. The tool result here also arrives before the SDK repeats
	// the tool-use message, which must not be streamed a second time.
	test("a turn started right after the previous one still receives its tool results", async () => {
		const main = agent("cleanup-race");
		claude.next(async function* (cc) { yield* cc.reply("hello"); });
		const first = [user("hi")];
		first.push(await stream(main, first).result());

		claude.next(async function* (cc) {
			const result = yield* cc.useTool("toolu_1", "bash", { command: "ls" });
			yield* cc.reply(`saw ${text(result)}`);
		});
		const second = [...first, user("list files")];
		second.push(await stream(main, second).result());
		second.push(toolResult("toolu_1", "file.txt"));
		expect(text(await run(main, second))).toBe("saw file.txt");
	});
});
