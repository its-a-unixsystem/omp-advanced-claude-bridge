import { createHash } from "node:crypto";
import type { Options, Settings } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "./config.js";

export interface ProviderPrompt {
	systemPrompt: NonNullable<Options["systemPrompt"]>;
	settingSources: Options["settingSources"];
	promptDigest: string;
	forwardsSystemPrompt: boolean;
}

export function buildProviderPrompt(
	prompt: readonly string[] | undefined,
	provider?: Config["provider"],
): ProviderPrompt {
	const preset = provider?.systemPromptPreset;
	const mode = preset === "claude_code" || preset === false || preset === null
		? preset
		: provider?.appendSystemPrompt === false ? "legacy" : "claude_code";
	const forwardsSystemPrompt = mode !== "legacy";
	const text = forwardsSystemPrompt ? prompt?.join("\n\n") ?? "" : "";
	return {
		systemPrompt: mode === false || mode === null
			? text
			: { type: "preset", preset: "claude_code", ...(forwardsSystemPrompt ? { append: text } : {}) },
		settingSources: forwardsSystemPrompt ? undefined : provider?.settingSources ?? ["user", "project"],
		promptDigest: createHash("sha256").update(JSON.stringify([mode, text])).digest("hex"),
		forwardsSystemPrompt,
	};
}

export function buildSdkSettings(autoMemoryEnabled?: boolean, forwardsSystemPrompt = false): Settings {
	return {
		autoMemoryEnabled: autoMemoryEnabled ?? false,
		outputStyle: "default",
		...(forwardsSystemPrompt ? { includeGitInstructions: false } : {}),
	};
}
