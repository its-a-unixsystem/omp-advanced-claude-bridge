// Deferred steers and aborts. Run with `bun test`; see tests/harness/bridge.ts.
//
// `test.failing` marks a known defect of port-baseline; the rewrite should
// turn each one into a plain `test`.

import { afterEach, describe, expect, test } from "bun:test";
import {
	agent, claude, createdSince, historyOf, resetHarness, run, sessionCalls, sessionState, settle, stream, text,
	toolResult, transcriptOf, user, type Agent,
} from "./harness/bridge.ts";

afterEach(resetHarness);

async function turn(who: Agent, history: any[], prompt: string, reply: string) {
	claude.next(async function* (cc) { yield* cc.reply(reply); });
	const next = [...history, user(prompt)];
	next.push(await run(who, next));
	return next;
}

/** Start a turn that runs `bash` and stops while the tool runs. The script
 *  answers `reply` once the tool result arrives. */
async function startBashTurn(who: Agent, history: any[], toolUseId: string, reply: string, extra: Record<string, unknown> = {}) {
	claude.next(async function* (cc) {
		yield* cc.useTool(toolUseId, "bash", { command: "make" });
		yield* cc.reply(reply);
	});
	const next = [...history, user("build it")];
	const toolUse = await run(who, next, extra);
	expect(toolUse.stopReason).toBe("toolUse");
	return [...next, toolUse];
}

describe("deferred steers", () => {
	test("a steer sent with a tool result is replayed after the query, resuming the same session", async () => {
		const main = agent("steer-main");
		const history = await startBashTurn(main, await turn(main, [], "hi", "hello"), "toolu_1", "built");
		const session = sessionState(main).sessionId;

		claude.next(async function* (cc) { yield* cc.reply("also tested"); });
		history.push(toolResult("toolu_1", "ok"), user("also run the tests"));
		const reply = await run(main, history);

		const continuation = claude.queries.at(-1)!;
		expect(claude.queries).toHaveLength(3);
		expect(continuation.prompt).toBe("also run the tests");
		expect(continuation.options.resume).toBe(session);
		expect(text(reply)).toBe("also tested");
		expect(sessionState(main).sessionId).toBe(session);
		expect(claude.queries.every((q) => q.isClosed)).toBe(true);
	});

	test("a subagent's steer resumes the subagent's session, not the parent's", async () => {
		const main = agent("steer-parent");
		const child = agent("steer-child");
		claude.next(async function* (cc) {
			const result = yield* cc.useTool("toolu_task", "task", { prompt: "build" });
			yield* cc.reply(`task said: ${text(result)}`);
		});
		const mainHistory = [user("delegate")];
		mainHistory.push(await run(main, mainHistory));
		const mainQuery = claude.queries[0];

		const childHistory = await startBashTurn(child, [], "toolu_child", "built");
		const childQuery = claude.queries[1];
		expect(childQuery.options.resume).toBeUndefined();

		claude.next(async function* (cc) { yield* cc.reply("also tested"); });
		childHistory.push(toolResult("toolu_child", "ok"), user("also run the tests"));
		const childReply = await run(child, childHistory);

		const continuation = claude.queries[2];
		expect(continuation.prompt).toBe("also run the tests");
		expect(continuation.options.resume).toBe(childQuery.sessionId);
		expect(text(childReply)).toBe("also tested");
		expect(sessionState(child).sessionId).toBe(childQuery.sessionId);
		expect(mainQuery.isClosed).toBe(false);

		mainHistory.push(toolResult("toolu_task", "built and tested", "task"));
		const mainReply = await run(main, mainHistory);
		expect(text(mainReply)).toBe("task said: built and tested");
		mainHistory.push(mainReply);
		expect(sessionState(main).sessionId).toBe(mainQuery.sessionId);
		expect(transcriptOf(mainQuery.sessionId)).toEqual(historyOf(mainHistory));
	});
});

describe("abort", () => {
	test("abort during a turn stops the query and the next turn moves to a new session", async () => {
		const main = agent("abort-main");
		const history = await turn(main, [], "hi", "hello");
		const session = sessionState(main).sessionId;

		claude.next(async function* (cc) { await cc.closed(); });
		const controller = new AbortController();
		const next = [...history, user("long task")];
		const pending = stream(main, next, { signal: controller.signal });
		await claude.waitForQueries(2);
		await settle();
		controller.abort();
		const aborted = await pending.result();
		expect(aborted.stopReason).toBe("aborted");
		const query = claude.queries[1];
		expect(query.interruptCalls).toBeGreaterThan(0);
		expect(query.isClosed).toBe(true);
		await settle();

		// The killed Claude Code process may still write to the old session
		// file, so the rebuild takes a new id and leaves the old file alone.
		const mark = sessionCalls.length;
		const after = await turn(main, [...next, aborted], "try again", "ok");
		const created = createdSince(mark);
		expect(created).toHaveLength(1);
		expect(created[0].sessionId).not.toBe(session);
		expect(sessionCalls.slice(mark)).not.toContainEqual({ op: "delete", sessionId: session });
		expect(claude.queries.at(-1)!.options.resume).toBe(created[0].sessionId);
		expect(transcriptOf(created[0].sessionId)).toEqual(historyOf(after));
	});

	test("abort while a tool runs resolves the waiting MCP handler and stops the query", async () => {
		const main = agent("abort-tool");
		const controller = new AbortController();
		await startBashTurn(main, [], "toolu_1", "never", { signal: controller.signal });
		const query = claude.queries[0];
		controller.abort();
		await settle();
		expect(query.interruptCalls).toBeGreaterThan(0);
		expect(query.isClosed).toBe(true);
	});

	// port-baseline kept an aborted query routable until its cleanup ran, which
	// waits for Claude Code to exit. A tool result that arrived in between went
	// to the dead query, and its stream ended with that query's abort, or never.
	test("a tool result that arrives between an abort and the query's cleanup is orphaned", async () => {
		const main = agent("abort-window-result");
		const controller = new AbortController();
		const history = await startBashTurn(main, await turn(main, [], "hi", "hello"), "toolu_1", "never", { signal: controller.signal });
		const session = sessionState(main).sessionId;
		const exit = claude.queries[1].holdExit();
		controller.abort();
		await settle();

		history.push(toolResult("toolu_1", "aborted"));
		const orphan = await Promise.race([stream(main, history).result(), settle().then(() => null)]);
		expect(orphan?.stopReason).toBe("stop");
		exit();
		await settle();

		await turn(main, [...history, orphan], "try again", "ok");
		const resume = claude.queries.at(-1)!.options.resume;
		expect(resume).toBeDefined();
		expect(resume).not.toBe(session);
	});

	// The same window with the user's next prompt: OMP sends the aborted tool
	// result followed by the prompt, which port-baseline took for a steer of
	// the dead query. The new turn must not resume or rewrite the session the
	// exiting process still writes to.
	test("a prompt sent between an abort and the query's cleanup starts a new turn in a new session", async () => {
		const main = agent("abort-window-prompt");
		const controller = new AbortController();
		const history = await startBashTurn(main, await turn(main, [], "hi", "hello"), "toolu_1", "never", { signal: controller.signal });
		const session = sessionState(main).sessionId;
		const exit = claude.queries[1].holdExit();
		controller.abort();
		await settle();

		claude.next(async function* (cc) { yield* cc.reply("starting over"); });
		history.push(toolResult("toolu_1", "aborted"), user("do something else"));
		const mark = sessionCalls.length;
		const reply = await Promise.race([stream(main, history).result(), settle().then(() => null)]);
		expect(claude.queries).toHaveLength(3);
		expect(claude.queries[2].prompt).toBe("do something else");
		expect(claude.queries[2].options.resume).not.toBe(session);
		expect(sessionCalls.slice(mark)).not.toContainEqual({ op: "delete", sessionId: session });
		expect(reply && text(reply)).toBe("starting over");
		exit();
	});

	test("abort during a continuation stops it", async () => {
		const main = agent("abort-continuation");
		const controller = new AbortController();
		const history = await startBashTurn(main, await turn(main, [], "hi", "hello"), "toolu_1", "built", { signal: controller.signal });

		claude.next(async function* (cc) {
			yield* cc.reply("starting the tests");
			await cc.closed();
		});
		history.push(toolResult("toolu_1", "ok"), user("also run the tests"));
		const pending = stream(main, history, { signal: controller.signal });
		await claude.waitForQueries(3);
		await settle();
		controller.abort();
		await pending.result();
		await settle();

		const continuation = claude.queries[2];
		expect(continuation.interruptCalls).toBeGreaterThan(0);
		expect(continuation.isClosed).toBe(true);
		expect(claude.queries).toHaveLength(3);
	});

	// port-baseline checked for an abort before steer replay only. An abort
	// during the continuation ended the stream with "stop" and left the session
	// marked as healthy, so the next turn resumed the session the killed
	// process may still write to.
	test("abort during a continuation reports the abort and moves the next turn to a new session", async () => {
		const main = agent("abort-continuation-state");
		const controller = new AbortController();
		const history = await startBashTurn(main, await turn(main, [], "hi", "hello"), "toolu_1", "built", { signal: controller.signal });
		const session = sessionState(main).sessionId;

		claude.next(async function* (cc) {
			yield* cc.reply("starting the tests");
			await cc.closed();
		});
		history.push(toolResult("toolu_1", "ok"), user("also run the tests"));
		const pending = stream(main, history, { signal: controller.signal });
		await claude.waitForQueries(3);
		await settle();
		controller.abort();
		const aborted = await pending.result();
		await settle();
		expect(aborted.stopReason).toBe("aborted");

		await turn(main, [...history, aborted], "try again", "ok");
		const resume = claude.queries.at(-1)!.options.resume;
		expect(resume).toBeDefined();
		expect(resume).not.toBe(session);
	});
});
