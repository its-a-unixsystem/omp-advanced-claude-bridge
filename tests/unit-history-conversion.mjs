import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { convertPiMessages } from "../src/convert.ts";
import { jsonSchemaToZodShape } from "../src/typebox-to-zod.ts";

test("history import retains user images alongside text", () => {
	const { anthropicMessages } = convertPiMessages([{
		role: "user",
		content: [
			{ type: "text", text: "What is shown?" },
			{ type: "image", mimeType: "image/png", data: "aGVsbG8=" },
		],
	}]);
	assert.deepEqual(anthropicMessages, [{
		role: "user",
		content: [
			{ type: "text", text: "What is shown?" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
		],
	}]);
});

test("imported tool calls and results share the sanitized ID and retain the historical tool name", () => {
	const id = "call:1/step.2";
	const { anthropicMessages, sanitizedIds } = convertPiMessages([
		{ role: "assistant", content: [{ type: "toolCall", id, name: "HTTPServer_lookup-v2-3", arguments: { key: "x" } }] },
		{ role: "toolResult", toolCallId: id, isError: true, content: [{ type: "text", text: "not found" }] },
	]);
	assert.deepEqual(anthropicMessages, [
		{ role: "assistant", content: [{ type: "tool_use", id: "call_1_step_2", name: "HttpServerLookupV2_3", input: { key: "x" } }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_1_step_2", content: "not found", is_error: true }] },
	]);
	assert.equal(sanitizedIds.get(id), "call_1_step_2");
});

test("tool schemas retain enums inside nested arrays", () => {
	const schema = z.object(jsonSchemaToZodShape({
		type: "object",
		properties: { modes: { type: "array", items: { type: "array", items: { enum: ["read", "none"] } } } },
		required: ["modes"],
	}));
	assert.deepEqual(z.toJSONSchema(schema).properties.modes.items.items.enum, ["read", "none"]);
	const input = { modes: [["read"], ["read", "none"]] };
	assert.deepEqual(schema.parse(input), input);
	assert.equal(schema.safeParse({ modes: [["full"]] }).success, false);
	assert.equal(schema.safeParse({ modes: ["read"] }).success, false);
});
