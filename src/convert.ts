// Pure pi→Anthropic message conversion helpers.
// Extracted so they can be tested without pulling in the full extension runtime.

import type { Message as PiMessage } from "@oh-my-pi/pi-ai";
import type { ContentBlock, ImageBlock, Message as SessionMessage, TextBlock, ToolResultBlock } from "cc-session-io";
export const PROVIDER_ID = "claude-bridge";

/** Roles Claude Code receives as a user turn. OMP sends `developer` messages
 *  (reminders, synthetic continues) as user turns on its own Anthropic provider too. */
export function isPromptRole(role: string): boolean {
	return role === "user" || role === "developer";
}

export const PI_TO_SDK_TOOL_NAME: Record<string, string> = {
	read: "Read", write: "Write", edit: "Edit", bash: "Bash",
};

export function sanitizeToolId(id: string, cache: Map<string, string>): string {
	const existing = cache.get(id);
	if (existing) return existing;
	const clean = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	cache.set(id, clean);
	return clean;
}

// Preserve acronym boundaries and numeric separators in imported tool names.
function pascalCaseToolName(name: string): string {
	const words = name
		.replace(/([\p{Ll}\d])(\p{Lu})/gu, "$1 $2")
		.replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
		.match(/[\p{L}\d]+/giu);
	if (!words) return "";
	return words.map((word, index) => {
		const initial = word[0];
		const prefix = index > 0 && initial >= "0" && initial <= "9" ? `_${initial}` : initial.toLocaleUpperCase();
		return prefix + word.slice(1).toLocaleLowerCase();
	}).join("");
}

export function mapPiToolNameToSdk(name: string, customToolNameToSdk?: Map<string, string>): string {
	if (!name) return "";
	const normalized = name.toLowerCase();
	if (customToolNameToSdk) {
		const mapped = customToolNameToSdk.get(name) ?? customToolNameToSdk.get(normalized);
		if (mapped) return mapped;
	}
	if (PI_TO_SDK_TOOL_NAME[normalized]) return PI_TO_SDK_TOOL_NAME[normalized];
	return pascalCaseToolName(name);
}

export function messageContentToText(
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	let hasText = false;
	for (const block of content) {
		if (block.type === "text" && block.text) { parts.push(block.text); hasText = true; }
		else if (block.type !== "text" && block.type !== "image") { parts.push(`[${block.type}]`); }
	}
	return hasText ? parts.join("\n") : "";
}

function promptBlocks(content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>): Array<TextBlock | ImageBlock> {
	const blocks: (TextBlock | ImageBlock)[] = [];
	for (const block of content) {
		if (block.type === "text" && block.text) blocks.push({ type: "text", text: block.text });
		else if (block.type === "image" && block.data && block.mimeType) {
			blocks.push({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
		}
	}
	return blocks;
}

/** Convert OMP message array to Anthropic API format. */
export function convertPiMessages(
	messages: PiMessage[],
	customToolNameToSdk?: Map<string, string>,
): { anthropicMessages: SessionMessage[]; sanitizedIds: Map<string, string>; origins: number[][] } {
	const anthropicMessages: SessionMessage[] = [];
	const sanitizedIds = new Map<string, string>();
	const origins: number[][] = [];
	let results: ToolResultBlock[] | undefined;
	const push = (index: number, message: SessionMessage) => {
		anthropicMessages.push(message);
		origins.push([index]);
	};

	for (const [index, msg] of messages.entries()) {
		if (isPromptRole(msg.role)) {
			// Skip empty developer messages without splitting a batch of tool results.
			const parts = Array.isArray(msg.content) ? promptBlocks(msg.content) : undefined;
			if (msg.role === "developer" && !messageContentToText(msg.content).trim()
				&& !parts?.some(block => block.type === "image")) continue;
			results = undefined;
			const content = typeof msg.content === "string" ? msg.content || "[empty]"
				: parts?.length ? parts : parts ? "[image]" : "[empty]";
			push(index, { role: "user", content });
		} else if (msg.role === "assistant") {
			results = undefined;
			const content = Array.isArray(msg.content) ? msg.content : [];
			const blocks: ContentBlock[] = [];
			for (const block of content) {
				if (block.type === "text" && block.text) {
					blocks.push({ type: "text", text: block.text });
				} else if (block.type === "thinking") {
					const sig = block.thinkingSignature;
					// Saved transcripts from earlier versions may use the previous provider ID.
					const isAnthropicProvider = msg.api === "anthropic-messages" || msg.provider === PROVIDER_ID || msg.provider === "advanced-claude-bridge";
					if (isAnthropicProvider && sig) {
						blocks.push({ type: "thinking", thinking: block.thinking ?? "", signature: sig });
					}
				} else if (block.type === "toolCall") {
					const toolName = mapPiToolNameToSdk(block.name, customToolNameToSdk);
					blocks.push({ type: "tool_use", id: sanitizeToolId(block.id, sanitizedIds), name: toolName, input: block.arguments ?? {} });
				}
			}
			if (!blocks.length) blocks.push({ type: "text", text: "[incompatible content omitted]" });
			push(index, { role: "assistant", content: blocks });
		} else if (msg.role === "toolResult") {
			if (!results) {
				results = [];
				push(index, { role: "user", content: results });
			} else origins[origins.length - 1].push(index);
			const content = msg.content;
			const blocks = Array.isArray(content) && content.some(block => block.type === "image" && block.data && block.mimeType)
				? promptBlocks(content) : messageContentToText(content);
			results.push({
				type: "tool_result", tool_use_id: sanitizeToolId(msg.toolCallId, sanitizedIds), content: blocks, is_error: msg.isError,
			});
		}
	}

	return { anthropicMessages, sanitizedIds, origins };
}
