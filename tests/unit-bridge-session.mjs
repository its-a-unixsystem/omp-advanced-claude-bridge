import test from "node:test";
import assert from "node:assert/strict";

import { bridgeSession } from "../src/bridge-session.ts";
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

	main.state = { ...synced, sessionId: "cc-main" };
	child.state = { ...synced, sessionId: "cc-child" };
	assert.equal(side.state, null);
	assert.equal(bridgeSession("main", mainStates).state.sessionId, "cc-main");

	for (const session of [main, side, child]) session.close();
	assert.equal(mainStates.size + childStates.size, 0);
});

test("a request without the agent's providerSessionState owns no session", () => {
	const states = new Map();
	const main = bridgeSession("helped", states);
	assert.equal(bridgeSession("helped", undefined), null);
	assert.equal(bridgeSession(undefined, states), null);
	assert.deepEqual([...states.keys()], ["advanced-claude-bridge:helped"]);
	main.close();
});

test("independent owner maps cannot share a native transcript by ID", () => {
	const main = bridgeSession("main", new Map());
	const second = bridgeSession("main", new Map());
	main.state = synced;
	assert.equal(second.beginTranscript().state, null);
});

test("closing a session forgets its state", () => {
	const states = new Map();
	const session = bridgeSession("closed", states);
	session.state = synced;
	session.close();
	assert.equal(session.state, null);
	assert.notEqual(bridgeSession("closed", states), session);
});

const synced = { sessionId: "cc", cwd: "/repo", claudeDir: "/claude", promptDigest: "digest", digests: [], uuids: [], cuttable: [], stamp: null, tailUuid: null, dirty: false };
test("only the latest writer can publish a transcript", () => {
	const session = bridgeSession("overlap", new Map());
	session.state = synced;
	const first = session.beginTranscript();
	assert.equal(first.state, synced);
	const second = session.beginTranscript();
	assert.equal(second.state, null);
	const newer = { ...synced, sessionId: "cc-2" };
	second.finish(newer);
	first.finish(null);
	assert.equal(session.beginTranscript().state, newer);
	session.close();
});

test("closing a session aborts its queries, and a query that ends later writes nothing", () => {
	const session = bridgeSession("closing", new Map());
	const query = new QueryContext();
	session.queries.add(query);
	const transcript = session.beginTranscript();
	session.close();
	assert.equal(query.aborted, true);
	transcript.finish(synced);
	assert.equal(session.state, null);
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
