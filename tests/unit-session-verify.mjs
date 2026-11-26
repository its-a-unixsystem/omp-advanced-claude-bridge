import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyWrittenSession } from "../src/session-verify.ts";

function writeSession(t, content) {
	const dir = mkdtempSync(join(tmpdir(), "bridge-session-verify-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "session.jsonl");
	writeFileSync(path, content);
	return path;
}

test("an empty session file is valid only when no records are expected", (t) => {
	const path = writeSession(t, "");
	assert.deepEqual(verifyWrittenSession(path, "expected", 0), []);
	const warnings = verifyWrittenSession(path, "expected", 1);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /^record count mismatch — expected=1 actual=0\b/);
});

test("the verifier detects session ID drift even when the record count matches", (t) => {
	const path = writeSession(t, '{"sessionId":"expected"}\n\n{"sessionId":"other"}\n');
	assert.deepEqual(verifyWrittenSession(path, "expected", 2), [
		"sessionId drift — expected=expected first=expected last=other",
	]);
});
