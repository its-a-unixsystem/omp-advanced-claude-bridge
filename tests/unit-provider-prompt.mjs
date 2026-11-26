import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { tryParseJson } from "../src/config.ts";
import { buildProviderPrompt, buildSdkSettings } from "../src/provider-prompt.ts";

const prompt = ["OMP base instructions\nwith formatting", "Extension instructions", "Project context"];
const joined = prompt.join("\n\n");
const presetPrompt = { type: "preset", preset: "claude_code", append: joined };

test("the default appends the entire rendered OMP prompt", () => {
	const options = buildProviderPrompt(prompt);
	assert.deepEqual(options.systemPrompt, presetPrompt);
	assert.equal(options.forwardsSystemPrompt, true);
	assert.equal(options.settingSources, undefined);
	assert.equal(options.promptDigest, createHash("sha256").update(JSON.stringify(["claude_code", joined])).digest("hex"));
	assert.equal(buildProviderPrompt([joined]).promptDigest, options.promptDigest);
	assert.equal(buildProviderPrompt(prompt, { systemPromptPreset: "claude_code" }).promptDigest, options.promptDigest);
	assert.notEqual(buildProviderPrompt([...prompt, "New instructions"]).promptDigest, options.promptDigest);
});

test("a valid explicit preset always overrides the legacy opt-out", () => {
	const legacy = { appendSystemPrompt: false, settingSources: ["local"] };
	const defaultPreset = buildProviderPrompt(prompt, { ...legacy, systemPromptPreset: "claude_code" });
	assert.deepEqual(defaultPreset.systemPrompt, presetPrompt);
	assert.equal(defaultPreset.settingSources, undefined);
	for (const systemPromptPreset of [false, null]) {
		const custom = buildProviderPrompt(prompt, { ...legacy, systemPromptPreset });
		assert.equal(custom.systemPrompt, joined);
		assert.equal(custom.settingSources, undefined);
		assert.equal(custom.forwardsSystemPrompt, true);
		assert.notEqual(custom.promptDigest, defaultPreset.promptDigest);
	}
	assert.equal(buildProviderPrompt(undefined, { systemPromptPreset: null }).systemPrompt, "");
});

test("legacy opt-out keeps the Claude Code preset and source fallback without forwarding", () => {
	const provider = { appendSystemPrompt: false };
	const legacy = buildProviderPrompt(prompt, provider);
	assert.deepEqual(legacy.systemPrompt, { type: "preset", preset: "claude_code" });
	assert.deepEqual(legacy.settingSources, ["user", "project"]);
	assert.equal(legacy.forwardsSystemPrompt, false);
	assert.equal(legacy.promptDigest, buildProviderPrompt(["Changed OMP prompt"], provider).promptDigest);
	assert.notEqual(legacy.promptDigest, buildProviderPrompt(undefined).promptDigest);
	assert.deepEqual(buildProviderPrompt(prompt, { ...provider, settingSources: [] }).settingSources, []);
});

test("invalid configured presets warn and fall back, while null survives parsing", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "advanced-claude-bridge-prompt-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "advanced-claude-bridge.json");
	const warn = t.mock.method(console, "error", () => {});
	for (const appendSystemPrompt of [false, true]) {
		writeFileSync(path, JSON.stringify({ provider: { systemPromptPreset: true, appendSystemPrompt } }));
		const { provider } = tryParseJson(path);
		assert.deepEqual(provider, { appendSystemPrompt });
		assert.equal(buildProviderPrompt(prompt, provider).forwardsSystemPrompt, appendSystemPrompt);
	}
	assert.equal(warn.mock.callCount(), 2);
	assert.match(warn.mock.calls[0].arguments[0], /^advanced-claude-bridge\.json: ignoring invalid provider\.systemPromptPreset.*expected "claude_code", false, or null/);
	assert.ok(warn.mock.calls[0].arguments[0].includes(path));
	writeFileSync(path, JSON.stringify({ provider: { systemPromptPreset: null, appendSystemPrompt: false } }));
	assert.equal(buildProviderPrompt(prompt, tryParseJson(path).provider).systemPrompt, joined);
	assert.equal(warn.mock.callCount(), 2);
});

test("SDK settings enforce the default output style and require a provider opt-in for memory", () => {
	assert.deepEqual(buildSdkSettings(), { autoMemoryEnabled: false, outputStyle: "default" });
	assert.deepEqual(buildSdkSettings(undefined, true), {
		autoMemoryEnabled: false,
		outputStyle: "default",
		includeGitInstructions: false,
	});
	assert.deepEqual(buildSdkSettings(true, true), {
		autoMemoryEnabled: true,
		outputStyle: "default",
		includeGitInstructions: false,
	});
});
