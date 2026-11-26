import test from "node:test";
import assert from "node:assert/strict";

import { historyFingerprint, planSync, replyIdentity } from "../src/history-sync.ts";

let clock = 1_000;
const user = (text) => ({ role: "user", content: text, timestamp: clock++ });
const assistant = (text, extra = {}) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: clock++, ...extra });
const toolUse = (id, args = { command: "make" }) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: args }], timestamp: clock++ });
const toolResult = (id, text = "ok") => ({ role: "toolResult", toolCallId: id, isError: false, content: [{ type: "text", text }], timestamp: clock++ });

/** The sync state a session has after a query that saw `history` and replied with `reply`. */
function synced(history, reply) {
	return { sessionId: "cc", cwd: "/repo", ...historyFingerprint(history), reply: reply && replyIdentity(reply) };
}

test("the first request with history rebuilds, a bare prompt starts clean", () => {
	assert.equal(planSync(null, [user("hi")]).path, "clean-start");
	const plan = planSync(null, [user("earlier"), assistant("answer"), user("now")]);
	assert.equal(plan.path, "rebuild");
	assert.equal(plan.reason, "first");
	assert.equal(plan.priors.cursor, 2);
	assert.equal(plan.request.cursor, 3);
});

test("the next turn reuses the session past the bridge's own reply", () => {
	const first = [user("hi")];
	const reply = assistant("hello");
	const next = [...first, reply, user("more")];
	const plan = planSync(synced(first, reply), next);
	assert.equal(plan.path, "reuse");
	assert.equal(plan.adoptedReply, true);
	assert.deepEqual(plan.priors, historyFingerprint(next.slice(0, -1)));
	assert.deepEqual(plan.request, historyFingerprint(next));
});

test("a changed tool payload on the same reply timestamp is not adopted", () => {
	const first = [user("build it")];
	const reply = toolUse("toolu_1");
	const edited = { ...reply, content: [{ ...reply.content[0], arguments: { command: "make clean" } }] };
	const plan = planSync(synced(first, reply), [...first, edited, user("next")]);
	assert.equal(plan.path, "rebuild");
});

test("an assistant message the bridge didn't send is missed history", () => {
	const first = [user("hi")];
	const reply = assistant("hello");
	const regenerated = assistant("hello from another model");
	const plan = planSync(synced(first, reply), [...first, regenerated, user("more")]);
	assert.equal(plan.path, "rebuild");
	assert.equal(plan.reason, "diverged");
});

test("history from another provider after the bridge's reply rebuilds", () => {
	const first = [user("hi")];
	const reply = assistant("hello");
	const plan = planSync(synced(first, reply), [...first, reply, user("other model"), assistant("other answer"), user("back")]);
	assert.equal(plan.path, "rebuild");
	assert.equal(plan.priors.cursor, 4);
});

test("a rewrite that keeps the message count is detected", () => {
	const history = [user("hi"), assistant("hello"), user("more")];
	const reply = assistant("sure");
	const edited = [history[0], { ...history[1], content: [{ type: "text", text: "hello (edited)" }] }, history[2], reply, user("next")];
	assert.equal(planSync(synced(history, reply), edited).path, "rebuild");
});

test("a tool output OMP pruned in place is detected", () => {
	const history = [user("build"), toolUse("toolu_1"), toolResult("toolu_1", "long output")];
	const reply = assistant("built");
	const pruned = [...history.slice(0, 2), { ...history[2], content: [{ type: "text", text: "[pruned]" }] }, reply, user("next")];
	assert.equal(planSync(synced(history, reply), pruned).path, "rebuild");
});

test("compaction and tree navigation shorten the history and rebuild", () => {
	const history = [user("hi"), assistant("hello"), user("more")];
	const reply = assistant("sure");
	const state = synced(history, reply);
	assert.equal(planSync(state, [user("Summary: hello"), user("next")]).path, "rebuild");
	assert.equal(planSync(state, [history[0], history[1], user("other direction")]).path, "rebuild");
	assert.equal(planSync(state, [user("start over")]).path, "clean-start");
});

test("metadata OMP adds or drops between requests is ignored", () => {
	const history = [user("hi"), assistant("hello", { usage: { input: 1 } })];
	const reply = assistant("sure");
	const later = [{ ...history[0], timestamp: 5 }, { ...history[1], usage: undefined, duration: 3 }, reply, user("next")];
	assert.equal(planSync(synced(history, reply), later).path, "reuse");
});

test("a flagged session rebuilds even when the history matches", () => {
	const first = [user("hi")];
	const reply = assistant("hello");
	const plan = planSync({ ...synced(first, reply), needsRebuild: true }, [...first, reply, user("again")]);
	assert.equal(plan.path, "rebuild");
	assert.equal(plan.reason, "flagged");
});

test("a missing reply forces a rebuild even when the earlier history matches", () => {
	const history = [user("build"), toolUse("toolu_1"), toolResult("toolu_1"), user("also test")];
	const request = [...history, user("next")];
	assert.equal(planSync(synced(history, assistant("tested")), request).path, "rebuild");
	assert.equal(planSync(synced(history), request).path, "reuse");
});
