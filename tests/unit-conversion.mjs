import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { convertPiMessages, isPromptRole } from "../src/convert.ts";
import { jsonSchemaToZodShape } from "../src/typebox-to-zod.ts";

test("history import preserves signed native Anthropic thinking but not unsigned or foreign thinking", () => {
	const content = [
		{ type: "thinking", thinking: "signed", thinkingSignature: "signature" },
		{ type: "thinking", thinking: "unsigned" },
		{ type: "text", text: "answer" },
	];
	const { anthropicMessages } = convertPiMessages([
		{ role: "assistant", api: "anthropic-messages", provider: "anthropic", content },
		{ role: "assistant", api: "openai-responses", provider: "openai", content },
	]);
	assert.deepEqual(anthropicMessages, [
		{ role: "assistant", content: [
			{ type: "thinking", thinking: "signed", signature: "signature" },
			{ type: "text", text: "answer" },
		] },
		{ role: "assistant", content: [{ type: "text", text: "answer" }] },
	]);
});

test("tool schemas advertise string and mixed primitive enums and tolerate unsupported enums", () => {
	const schema = z.object(jsonSchemaToZodShape({
		type: "object",
		properties: {
			mode: { enum: ["read", "none"] },
			values: { type: "array", items: { enum: [1, "auto", false, null] } },
			empty: { enum: [] },
			object: { enum: [{ kind: "custom" }] },
		},
		required: ["mode", "values"],
	}));
	const wire = z.toJSONSchema(schema);
	assert.deepEqual(wire.properties.mode.enum, ["read", "none"]);
	assert.deepEqual(wire.properties.values.items.enum, [1, "auto", false, null]);
	const input = { mode: "read", values: [1, "auto", false, null], empty: 5, object: { kind: "custom" } };
	assert.deepEqual(schema.parse(input), input);
	assert.equal(schema.safeParse({ ...input, values: [2] }).success, false);
});

test("developer messages convert to user turns and empty ones are skipped", () => {
	assert.equal(isPromptRole("user"), true);
	assert.equal(isPromptRole("developer"), true);
	assert.equal(isPromptRole("assistant"), false);
	assert.equal(isPromptRole("toolResult"), false);

	const { anthropicMessages } = convertPiMessages([
		{ role: "user", content: "hi" },
		{ role: "assistant", content: [{ type: "text", text: "hello" }] },
		{ role: "developer", content: "<system-reminder>keep going</system-reminder>" },
		{ role: "developer", content: [{ type: "text", text: "array form" }] },
		{ role: "developer", content: "   " },
		{ role: "developer", content: [] },
	]);
	assert.deepEqual(anthropicMessages, [
		{ role: "user", content: "hi" },
		{ role: "assistant", content: [{ type: "text", text: "hello" }] },
		{ role: "user", content: "<system-reminder>keep going</system-reminder>" },
		{ role: "user", content: [{ type: "text", text: "array form" }] },
	]);
});

test("tool schemas flatten top-level anyOf/allOf combinators", () => {
	const anyOfSchema = z.object(jsonSchemaToZodShape({
		anyOf: [
			{ type: "object", properties: { path: { type: "string" }, line: { type: "number" } }, required: ["path"] },
			{ type: "object", properties: { path: { type: "string" }, query: { type: "string" } }, required: ["path", "query"] },
		],
	}));
	assert.deepEqual(anyOfSchema.parse({ path: "a.ts", line: 3 }), { path: "a.ts", line: 3 });
	assert.equal(anyOfSchema.safeParse({ line: 3 }).success, false);
});
