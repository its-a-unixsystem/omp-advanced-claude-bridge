import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getSessionPath, openSession } from "cc-session-io";
import { recordTurn, syncHistory } from "../src/history-sync.ts";

const prompt = "system prompt digest";
let clock = 1000;
const text = text => ({ type: "text", text });
const image = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
const nativeImage = { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } };
const user = content => ({ role: "user", content, timestamp: clock++ });
const developer = content => ({ role: "developer", content, synthetic: true, timestamp: clock++ });
const assistant = (...content) => ({
	role: "assistant", provider: "claude-bridge", api: "claude-agent-sdk",
	content, stopReason: "stop", timestamp: clock++,
});
const call = (id, args = { command: "make" }) => ({ type: "toolCall", name: "bash", id, arguments: args });
const result = (toolCallId, content) => ({ role: "toolResult", toolCallId, toolName: "bash", content, isError: false, timestamp: clock++ });

function fixture(t) {
	const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-history-"));
	const claudeDir = join(cwd, "claude");
	const oldClaudeDir = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = claudeDir;
	t.after(() => {
		if (oldClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = oldClaudeDir;
		rmSync(cwd, { recursive: true, force: true });
	});
	return {
		cwd, claudeDir,
		path: state => getSessionPath(state.sessionId, cwd, claudeDir),
		open: state => openSession({ sessionId: state.sessionId, projectPath: cwd, claudeDir }),
	};
}

function appendNative(path, state, records) {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, records.map((record, i) => JSON.stringify({
		sessionId: state.sessionId, parentUuid: i ? records[i - 1].uuid : state.tailUuid, isSidechain: false,
		timestamp: new Date(Date.now() + i + 10).toISOString(), ...record,
	})).join("\n") + "\n");
}

test("first sync starts clean without replayable history and writes a private transcript otherwise", t => {
	const { cwd, path, open } = fixture(t);
	const base = syncHistory(null, [], cwd, prompt);
	assert.equal(base.stamp, null);
	assert.equal(existsSync(path(base)), false);
	const omitted = syncHistory(null, [developer("  ")], cwd, prompt);
	assert.equal(omitted.stamp, null);
	assert.deepEqual(omitted.uuids, [null]);

	const now = 1700000000000;
	t.mock.method(Date, "now", () => now);
	const history = [user("earlier"), assistant(text("answer")), developer("continue")];
	const writes = [];
	const state = syncHistory(null, history, cwd, prompt, undefined, undefined, (...args) => writes.push(args));
	assert.deepEqual(open(state).messages.map(record => record.message.content), ["earlier", [text("answer")], "continue"]);
	assert.deepEqual(open(state).messages.map(record => Date.parse(record.timestamp)), [now - 2, now - 1, now]);
	assert.equal(statSync(path(state)).mode & 0o777, 0o600);
	assert.deepEqual(writes, [[path(state), state.sessionId, 3, cwd]]);
	assert.equal(syncHistory(state, history, cwd, prompt, undefined, undefined, (...args) => writes.push(args)), state);
	assert.equal(writes.length, 1);
});

test("native continuation proves its live reply and keeps attachments when branching", t => {
	const { cwd, path, open } = fixture(t);
	const base = syncHistory(null, [], cwd, prompt);
	const first = developer([text("read @data.txt"), image]);
	const reply = assistant(text("old answer"));
	const attachment = { type: "file", filename: "data.txt", content: { type: "text", file: { content: "native data" } } };
	const native = [
		{ type: "user", uuid: randomUUID(), message: { role: "user", content: [text("read @data.txt"), nativeImage] } },
		{ type: "attachment", uuid: randomUUID(), attachment },
		{ type: "assistant", uuid: randomUUID(), message: { role: "assistant", id: "native-response", content: [text("old answer")] } },
	];
	appendNative(path(base), base, native);
	const recorded = recordTurn(base, native[0].uuid, [first, reply], true);
	assert.equal(recorded.dirty, false);
	assert.equal(recorded.tailUuid, native[2].uuid);
	assert.equal(syncHistory(recorded, [{ ...first, timestamp: 5 }, { ...reply, usage: { input: 15 } }], cwd, prompt), recorded);

	const regenerated = { ...reply, timestamp: reply.timestamp + 1 };
	assert.notEqual(syncHistory(recorded, [first, regenerated], cwd, prompt).sessionId, base.sessionId);
	const loaded = JSON.parse(JSON.stringify(recorded));
	assert.equal(syncHistory(loaded, [first, regenerated], cwd, prompt), loaded);

	const writes = [];
	const fork = syncHistory(recorded, [first, assistant(text("edited answer"))], cwd, prompt, undefined, undefined, (...args) => writes.push(args));
	const transcript = open(fork);
	assert.notEqual(fork.sessionId, base.sessionId);
	assert.deepEqual(transcript.attachments.map(row => [row.uuid, row.attachment]), [[native[1].uuid, attachment]]);
	assert.equal(transcript.messages[1].parentUuid, native[1].uuid);
	assert.equal(transcript.messages[1].message.content[0].text, "edited answer");
	assert(transcript.records.every(row => row.sessionId === fork.sessionId));
	assert.deepEqual(writes, [[path(fork), fork.sessionId, 3, cwd]]);

	const changedPrompt = syncHistory(recorded, [first, reply], cwd, "different system prompt");
	assert.notEqual(changedPrompt.sessionId, base.sessionId);
	assert.equal(open(changedPrompt).attachments.length, 0);
});

test("forks verify the retained native bytes but ignore changes after the cut", t => {
	const { cwd, path, open } = fixture(t);
	const base = syncHistory(null, [], cwd, prompt);
	const first = user(`keep A: ${"漢".repeat(26_000)}`);
	const reply = assistant(text("old answer"));
	const attachment = { type: "file", filename: "data.txt", content: "native data" };
	const native = [
		{ type: "user", uuid: randomUUID(), message: { role: "user", content: first.content } },
		{ type: "attachment", uuid: randomUUID(), attachment },
		{ type: "assistant", uuid: randomUUID(), message: { id: "answer", content: [text("old answer")] } },
	];
	const source = path(base);
	appendNative(source, base, native);
	const saved = JSON.parse(JSON.stringify(recordTurn(base, native[0].uuid, [first, reply], true)));
	const bytes = readFileSync(source, "utf8");
	writeFileSync(source, bytes.replace("old answer", "new answer"));
	const fork = syncHistory(saved, [first], cwd, prompt);
	assert.deepEqual(open(fork).attachments.map(row => row.uuid), [native[1].uuid]);

	writeFileSync(source, bytes.replace("keep A", "keep B"));
	const rebuilt = syncHistory(saved, [first, reply], cwd, prompt);
	const transcript = open(rebuilt);
	assert.equal(transcript.messages[0].message.content, first.content);
	assert.notEqual(transcript.messages[0].uuid, native[0].uuid);
	assert.equal(transcript.attachments.length, 0);
});

test("pruning or editing a tool batch rewrites it from the last safe cut", t => {
	const { cwd, path, open } = fixture(t);
	const first = user("read two files");
	const tools = assistant(call("a"), call("b"));
	const a = result("a", "old A");
	const b = result("b", "long B");
	const reply = assistant(text("old response"));
	const old = syncHistory(null, [first, tools, a, b, reply], cwd, prompt);
	const source = readFileSync(path(old), "utf8");
	assert.deepEqual(old.cuttable, [true, false, false, true, true]);
	assert.equal(old.uuids[2], old.uuids[3]);

	// A partially written tail does not spoil the proven prefix.
	appendFileSync(path(old), "{unfinished");
	const updated = [first, tools, a, result("b", [text("[pruned]"), image]), user([text("updated"), image])];
	const fork = syncHistory(old, updated, cwd, prompt);
	const rows = open(fork).messages;
	assert.notEqual(fork.sessionId, old.sessionId);
	assert.equal(rows[0].uuid, old.uuids[0]);
	assert.notEqual(rows[1].uuid, old.uuids[1]);
	assert.deepEqual(rows[2].message.content, [
		{ type: "tool_result", tool_use_id: "a", content: "old A", is_error: false },
		{ type: "tool_result", tool_use_id: "b", content: [text("[pruned]"), nativeImage], is_error: false },
	]);
	assert.deepEqual(rows[3].message.content, [text("updated"), nativeImage]);
	assert.equal(rows.length, 4);
	assert.equal(readFileSync(path(old), "utf8"), source + "{unfinished");
});

test("same-length rewrites, tree navigation, and later foreign turns do not resume the old transcript", t => {
	const { cwd, open } = fixture(t);
	const first = user("build");
	const tools = assistant(call("a"));
	const output = result("a", [text("built")]);
	const reply = assistant(text("done"));
	const history = [first, tools, output, reply];
	const state = syncHistory(null, history, cwd, prompt);
	const edited = { ...tools, content: [call("a", { command: "make clean" })] };
	assert.notEqual(syncHistory(state, [first, edited, output, reply], cwd, prompt).sessionId, state.sessionId);

	const missingReply = syncHistory(state, history.slice(0, -1), cwd, prompt);
	assert.notEqual(missingReply.sessionId, state.sessionId);
	assert.equal(open(missingReply).messages.length, 3);
	assert.equal(missingReply.tailUuid, state.uuids[2]);

	const different = syncHistory(state, [user("Summary: built")], cwd, prompt);
	assert.notEqual(open(different).messages[0].uuid, state.uuids[0]);
	assert.equal(syncHistory(state, [], cwd, prompt).stamp, null);

	const foreign = { ...assistant(text("other answer")), provider: "another-provider" };
	const fork = syncHistory(state, [...history, user("other model"), foreign], cwd, prompt);
	assert.notEqual(fork.sessionId, state.sessionId);
	assert.equal(open(fork).messages[3].uuid, state.tailUuid);
	assert.deepEqual(open(fork).messages[5].message.content, [text("other answer")]);
});

test("repair records only actual origins and does not cut into synthesized or partial tool batches", t => {
	const { cwd, open } = fixture(t);
	const first = user("build");
	const tools = assistant(call("a"), call("b"));
	const orphan = result("not-called", "drop this");
	const a = result("a", "real result");
	const later = developer("continue");
	const state = syncHistory(null, [first, tools, orphan, developer(""), a, later], cwd, prompt);
	const rows = open(state).messages;
	assert.deepEqual(rows[2].message.content, [
		{ type: "tool_result", tool_use_id: "b", content: "[no tool result recorded]", is_error: true },
		{ type: "tool_result", tool_use_id: "a", content: "real result", is_error: false },
	]);
	assert.deepEqual(state.uuids, [rows[0].uuid, rows[1].uuid, null, null, rows[2].uuid, rows[3].uuid]);
	assert.deepEqual(state.cuttable, [true, false, false, false, false, true]);
});

test("native split assistant responses and result batches align, but an unmatched tail is dirty", t => {
	const { cwd, path, open } = fixture(t);
	const base = syncHistory(null, [user("prior turn"), assistant(text("yes"))], cwd, prompt);
	const first = user("build two targets");
	const calls = assistant(text("starting"), call("a"), call("b"));
	const a = result("a", "built");
	const b = result("b", "built");
	const reply = assistant(text("done"));
	const native = [
		{ type: "user", uuid: randomUUID(), message: { role: "user", content: first.content } },
		{ type: "assistant", uuid: randomUUID(), message: { id: "tools", content: [text("starting")] } },
		{ type: "assistant", uuid: randomUUID(), message: { id: "tools", content: [
			{ type: "tool_use", id: "a", name: "Bash", input: {} },
			{ type: "tool_use", id: "b", name: "Bash", input: {} },
		] } },
		{ type: "user", uuid: randomUUID(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: "built" }] } },
		{ type: "user", uuid: randomUUID(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "built" }] } },
		{ type: "assistant", uuid: randomUUID(), message: { id: "answer", content: [text("done")] } },
		{ type: "assistant", uuid: randomUUID(), message: { id: "extra", content: [text("unmatched native output")] } },
	];
	appendNative(path(base), base, native);
	const recorded = recordTurn(base, native[0].uuid, [first, calls, a, b, reply], true);
	assert.equal(recorded.dirty, true);
	assert.deepEqual(recorded.cuttable.slice(-5), [true, false, false, true, true]);
	assert.deepEqual(recorded.uuids.slice(-5), [native[0].uuid, native[2].uuid, native[4].uuid, native[4].uuid, native[5].uuid]);
	assert.equal(recorded.tailUuid, native[6].uuid);

	const dirty = recordTurn(base, randomUUID(), [first, calls, a, b, reply], true);
	assert.deepEqual(dirty.uuids, base.uuids);
	assert(dirty.dirty);
	const fork = syncHistory(dirty, [user("prior turn"), assistant(text("yes"))], cwd, prompt);
	assert.notEqual(fork.sessionId, base.sessionId);
	assert.deepEqual(open(fork).messages.map(record => record.uuid), base.uuids);
});

test("a duplicate native tool result still leaves the new prompt and its attachment forkable", t => {
	const { cwd, path, open } = fixture(t);
	const prior = user("prior turn");
	const base = syncHistory(null, [prior], cwd, prompt);
	const first = user("build @data.txt");
	const use = { type: "tool_use", id: "a", name: "Bash", input: {} };
	const output = { type: "tool_result", tool_use_id: "a", content: "built" };
	const native = [
		{ type: "user", uuid: randomUUID(), message: { role: "user", content: first.content } },
		{ type: "attachment", uuid: randomUUID(), attachment: { type: "file", filename: "data.txt", content: "native data" } },
		{ type: "assistant", uuid: randomUUID(), message: { id: "tools", content: [use] } },
		{ type: "user", uuid: randomUUID(), message: { role: "user", content: [output, output] } },
	];
	appendNative(path(base), base, native);
	const recorded = recordTurn(base, native[0].uuid, [first, assistant(call("a")), result("a", "built")], true);
	assert.equal(recorded.dirty, true);
	const fork = syncHistory(recorded, [prior, first], cwd, prompt);
	assert.notEqual(fork.sessionId, base.sessionId);
	assert.deepEqual(open(fork).messages.map(row => row.uuid), [base.uuids[0], native[0].uuid]);
	assert.deepEqual(open(fork).attachments.map(row => row.uuid), [native[1].uuid]);
});

test("missing or unreadable transcripts are rebuilt from OMP history", t => {
	const { cwd, path, open } = fixture(t);
	const history = [user("restorable")];
	const state = syncHistory(null, history, cwd, prompt);
	rmSync(path(state));
	const missing = syncHistory(state, history, cwd, prompt);
	assert.notEqual(missing.sessionId, state.sessionId);
	assert.equal(open(missing).messages[0].message.content, "restorable");
	writeFileSync(path(missing), "invalid jsonl\n");
	const recovered = syncHistory(missing, history, cwd, prompt);
	assert.notEqual(recovered.sessionId, missing.sessionId);
	assert.equal(open(recovered).messages[0].message.content, "restorable");
});
