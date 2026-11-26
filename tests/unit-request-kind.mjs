import test from "node:test";
import assert from "node:assert/strict";

import { classifyRequest } from "../src/request-kind.ts";
import { QueryContext } from "../src/query-state.ts";

const user = (text) => ({ role: "user", content: text });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
const toolUse = (id) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: {} }] });
const toolResult = (id, text = "ok") => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text }] });

function session(queries = []) {
	return { queries: new Set(queries) };
}

function queryWaitingOn(id) {
	const query = new QueryContext();
	query.turnToolCallIds.push(id);
	return query;
}

test("a user prompt on a new session is a turn", () => {
	assert.deepEqual(classifyRequest([user("hi")], session()), { kind: "turn" });
});

test("a prompt with history is a turn, whatever the session synced", () => {
	const messages = [user("hi"), assistant("hello"), user("more")];
	assert.deepEqual(classifyRequest(messages, session()), { kind: "turn" });
});

test("a request that owns no session is a helper", () => {
	assert.deepEqual(classifyRequest([user("Write a title")], null), { kind: "helper" });
	const history = [user("hi"), assistant("hello"), user("Advisor: review")];
	assert.deepEqual(classifyRequest(history, null), { kind: "helper" });
});

test("a tool result in a request that owns no session is orphaned", () => {
	const messages = [user("judge"), toolUse("toolu_1"), toolResult("toolu_1")];
	assert.deepEqual(classifyRequest(messages, null), { kind: "orphaned-result" });
});

test("tool results go to the query of this session that issued the call", () => {
	const other = queryWaitingOn("toolu_other");
	const owner = queryWaitingOn("toolu_1");
	const messages = [user("build"), toolUse("toolu_1"), toolResult("toolu_1", "built")];
	const request = classifyRequest(messages, session([other, owner]));
	assert.equal(request.kind, "tool-results");
	assert.equal(request.query, owner);
	assert.equal(request.steer, false);
	assert.deepEqual(request.results.map((r) => r.toolCallId), ["toolu_1"]);
});

test("a query owns a call while its handler waits and while its result is queued", () => {
	const waiting = new QueryContext();
	waiting.pendingToolCalls.set("toolu_wait", { toolName: "bash", resolve: () => {} });
	const queued = new QueryContext();
	queued.pendingResults.set("toolu_queued", { content: [] });
	const owners = session([waiting, queued]);
	assert.equal(classifyRequest([toolUse("toolu_wait"), toolResult("toolu_wait")], owners).query, waiting);
	assert.equal(classifyRequest([toolUse("toolu_queued"), toolResult("toolu_queued")], owners).query, queued);
});

test("a user message after the tool results is a steer for the same query", () => {
	const owner = queryWaitingOn("toolu_1");
	const messages = [user("build"), toolUse("toolu_1"), toolResult("toolu_1"), user("also test")];
	const request = classifyRequest(messages, session([owner]));
	assert.equal(request.kind, "tool-results");
	assert.equal(request.query, owner);
	assert.equal(request.steer, true);
});

test("a tool result with no query of this session waiting is orphaned", () => {
	const messages = [user("build"), toolUse("toolu_1"), toolResult("toolu_1", "aborted")];
	assert.deepEqual(classifyRequest(messages, session()), { kind: "orphaned-result" });
	// A query in some other session is not consulted.
	const elsewhere = session([queryWaitingOn("toolu_2")]);
	assert.deepEqual(classifyRequest(messages, elsewhere), { kind: "orphaned-result" });
});

test("tool results from an earlier turn do not route a later prompt", () => {
	const owner = queryWaitingOn("toolu_1");
	const messages = [user("build"), toolUse("toolu_1"), toolResult("toolu_1"), assistant("built"), user("next")];
	assert.deepEqual(classifyRequest(messages, session([owner])), { kind: "turn" });
});

test("orphaned results followed by a user message start a turn", () => {
	const messages = [user("build"), toolUse("toolu_1"), toolResult("toolu_1", "aborted"), user("try again")];
	assert.deepEqual(classifyRequest(messages, session()), { kind: "turn" });
});
