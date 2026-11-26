import test from "node:test";
import assert from "node:assert/strict";

import { bridgeSession, bridgeSessions, sharedSession, stateAfterQuery } from "../src/bridge-session.ts";
import { QueryContext } from "../src/query-state.ts";

test("each provider sessionId owns its Claude Code session", () => {
	const mainStates = new Map();
	const childStates = new Map();
	const main = bridgeSession("main", mainStates);
	const side = bridgeSession("main:side:1", mainStates);
	const child = bridgeSession("child", childStates);

	assert.equal(bridgeSession("main", mainStates), main);
	assert.notEqual(side, main);
	assert.notEqual(child, main);
	assert.deepEqual([...mainStates.keys()], ["advanced-claude-bridge:main", "advanced-claude-bridge:main:side:1"]);
	assert.deepEqual([...childStates.keys()], ["advanced-claude-bridge:child"]);

	main.state = { sessionId: "cc-main", cwd: "/repo", cursor: 6, prefix: "a" };
	child.state = { sessionId: "cc-child", cwd: "/repo", cursor: 2, prefix: "b" };
	assert.equal(side.state, null);
	assert.equal(bridgeSession("main", mainStates).state.cursor, 6);

	for (const session of [main, side, child]) session.close();
	assert.equal(bridgeSessions.size, 0);
});

test("a request without the agent's providerSessionState owns no session", () => {
	const states = new Map();
	const main = bridgeSession("helped", states);
	assert.equal(bridgeSession("helped", undefined), null);
	assert.equal(bridgeSession(undefined, states), null);
	assert.deepEqual([...states.keys()], ["advanced-claude-bridge:helped"]);
	main.close();
});

test("AskClaude finds the provider's session by sessionId", () => {
	const states = new Map();
	const provider = bridgeSession("main", states);
	assert.equal(sharedSession("main"), provider);
	provider.close();
});

test("closing a session forgets its state", () => {
	const states = new Map();
	const session = bridgeSession("closed", states);
	session.state = { sessionId: "cc", cwd: "/repo", cursor: 0, prefix: "" };
	session.close();
	assert.equal(session.state, null);
	assert.notEqual(bridgeSession("closed", states), session);
	sharedSession("closed").close();
});

test("AskClaude without a sessionId shares nothing", () => {
	assert.notEqual(sharedSession(undefined), sharedSession(undefined));
	assert.equal(bridgeSessions.size, 0);
});

const synced = { sessionId: "cc", cwd: "/repo", cursor: 2, prefix: "p" };

test("a finished query leaves the history it synced and its reply", () => {
	const end = { kind: "done", sessionId: "cc-2", cwd: "/other", synced: { cursor: 4, prefix: "q" }, reply: 7 };
	assert.deepEqual(stateAfterQuery(synced, end), { sessionId: "cc-2", cwd: "/other", cursor: 4, prefix: "q", reply: 7 });
	assert.equal(stateAfterQuery(synced, { ...end, sessionId: undefined }), synced);
});

test("an aborted query flags its session for a rebuild under a new id", () => {
	assert.deepEqual(stateAfterQuery(synced, { kind: "aborted" }), { ...synced, needsRebuild: true, forceRotate: true });
	assert.equal(stateAfterQuery(null, { kind: "aborted" }), null);
});

test("a failed query leaves no sync state", () => {
	assert.equal(stateAfterQuery(synced, { kind: "error" }), null);
});

test("closing a session aborts its queries, and a query that ends later writes nothing", () => {
	const session = bridgeSession("closing", new Map());
	const query = new QueryContext();
	session.queries.add(query);
	session.close();
	assert.equal(query.aborted, true);
	session.endQuery(query, { kind: "aborted" });
	assert.equal(session.state, null);
	assert.equal(session.queries.size, 0);
});

test("releasing a side request closes only its own session and drops it from the map", () => {
	const states = new Map();
	const main = bridgeSession("rel", states);
	const side = bridgeSession("rel:side:1", states);
	main.state = synced;
	const query = new QueryContext();
	side.queries.add(query);
	for (const state of [...states.values()]) state.releaseSession("rel:side:1");
	assert.equal(query.aborted, true);
	assert.equal(side.closed, true);
	assert.equal(main.closed, false);
	assert.equal(main.state, synced);
	assert.deepEqual([...states.keys()], ["advanced-claude-bridge:rel"]);
	main.close();
});
