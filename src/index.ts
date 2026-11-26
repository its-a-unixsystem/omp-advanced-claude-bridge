import { createAssistantMessageEventStream, toolWireSchema, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type ProviderResponseMetadata, type SimpleStreamOptions, type Tool, type Usage } from "@oh-my-pi/pi-ai";
import { getBundledModelSlice } from "@oh-my-pi/pi-catalog/models";
import { buildSessionContext, formatKeyHint, getKeybindings, type CompactionEntry, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import { compact } from "@oh-my-pi/pi-agent-core/compaction";
import { createSdkMcpServer, query, type Options, type Query, type SDKMessage, type SDKResultMessage, type SDKUserMessage, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { Base64ImageSource, ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { jsx } from "@oh-my-pi/pi-tui";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { randomUUID } from "node:crypto";
import { deleteSession } from "cc-session-io";
import { appendFileSync, mkdirSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { PROVIDER_ID, isPromptRole, messageContentToText } from "./convert.js";
import { buildVariantModels, buildModels, claudeCodeEffort, claudeCodeModelId, type ContextWindowMode, type LongContextSettings, resolveModel as _resolveModel } from "./models.js";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX, extractSkillsBlock } from "./skills.js";
import { verifyWrittenSession as _verifyWrittenSession } from "./session-verify.js";
import type { McpResult } from "./extract-tool-results.js";
import { QueryContext } from "./query-state.js";
import { type BridgeSession, type TranscriptLease, bridgeSession } from "./bridge-session.js";
import { classifyRequest, type RequestKind } from "./request-kind.js";
import { recordTurn, syncHistory, type SessionState } from "./history-sync.js";
import { loadConfig, type Config } from "./config.js";
import { buildProviderPrompt, buildSdkSettings, type ProviderPrompt } from "./provider-prompt.js";
import { SessionStore } from "./session-store.js";
import { jsonSchemaToZodShape } from "./typebox-to-zod.js";
import { buildActionSummary, type ToolCallState } from "./askclaude-ui.js";
import { describeRateLimitFailure, isSessionLimitNotice, rateLimitNotice, rateLimitResponse } from "./rate-limit.js";

// Shared env guards for every Claude Code subprocess:
// - ENABLE_CLAUDEAI_MCP_SERVERS=0: keep claude.ai cloud MCP servers out of OMP sessions.
// - DISABLE_AUTO_COMPACT=1: OMP owns compaction and history truth.
// - CLAUDE_CODE_ELEGANT_MEADOW=0: disable CC 2.1.308+ per-request API logs in session files.
const CC_CHILD_ENV = {
	ENABLE_CLAUDEAI_MCP_SERVERS: "0",
	DISABLE_AUTO_COMPACT: "1",
	CLAUDE_CODE_ELEGANT_MEADOW: "0",
} as const;

function calculateCost(model: Model<any>, usage: Usage): Usage["cost"] {
	usage.cost.input = (model.cost.input / 1_000_000) * usage.input;
	usage.cost.output = (model.cost.output / 1_000_000) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / 1_000_000) * usage.cacheRead;
	usage.cost.cacheWrite = (model.cost.cacheWrite / 1_000_000) * usage.cacheWrite;
	return usage.cost;
}

// --- Debug logging ---
// CLAUDE_BRIDGE_DEBUG=1 enables debug logging to ~/.omp/agent/claude-bridge.log

const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG === "1";
const DEBUG_LOG_PATH = process.env.CLAUDE_BRIDGE_DEBUG_PATH || join(homedir(), ".omp", "agent", "claude-bridge.log");
const DIAG_LOG_PATH = join(homedir(), ".omp", "agent", "claude-bridge-diag.log");

// Ensure log directories exist when debug is enabled
if (DEBUG) {
	try {
		mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true });
	} catch {
		// If directory creation fails, debug functions will throw on first use
	}
}

// Unique per module evaluation — confirms whether subagents share module state
const moduleInstanceId = Math.random().toString(36).slice(2, 8);

function debug(...args: unknown[]) {
	if (!DEBUG) return;
	const ts = new Date().toISOString();
	const fmt = (a: unknown): string => {
		if (typeof a === "string") return a;
		if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? "\n" + a.stack : ""}`;
		return JSON.stringify(a);
	};
	const msg = args.map(fmt).join(" ");
	appendFileSync(DEBUG_LOG_PATH, `[${ts}] [${moduleInstanceId}] ${msg}\n`);
}

// Per-query CLI debug capture. When CLAUDE_BRIDGE_DEBUG=1, ask the Claude Code
// CLI subprocess to write its own debug log to a file we choose, and also
// forward its stderr into our debug stream. Drops straight into the real SDK's
// Options — see @anthropic-ai/claude-agent-sdk sdk.d.ts:1245 (debug, debugFile,
// stderr). Without this, CC's internal view of the world is invisible to us
// and "No conversation found" / empty-error reports are unactionable.
let nextCliDebugSeq = 1;
function makeCliDebugOptions(tag: string): { debug?: boolean; debugFile?: string; stderr?: (data: string) => void } {
	if (!DEBUG) return {};
	const seq = nextCliDebugSeq++;
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const logDir = join(dirname(DEBUG_LOG_PATH), "cc-cli-logs");
	try { mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }
	const debugFile = join(logDir, `${ts}-${tag}-${seq}.log`);
	debug(`cli-debug: ${tag} #${seq} → ${debugFile}`);
	return {
		debug: true,
		debugFile,
		stderr: (data: string) => {
			for (const line of data.split(/\r?\n/)) {
				if (line) debug(`[cli-stderr ${tag}#${seq}] ${line}`);
			}
		},
	};
}

/** Unconditional diagnostic dump — for "should never happen" paths */
function diagDump(label: string, data: Record<string, unknown>) {
	try {
		mkdirSync(dirname(DIAG_LOG_PATH), { recursive: true });
		const entry = { ts: new Date().toISOString(), moduleInstanceId, label, ...data };
		appendFileSync(DIAG_LOG_PATH, JSON.stringify(entry) + "\n");
		debug(`DIAG: ${label} (see ${DIAG_LOG_PATH})`);
	} catch {
		// Diagnostic logging must not interrupt recovery.
	}
}

// --- Constants ---

const SDK_TO_PI_TOOL_NAME: Record<string, string> = {
	read: "read", write: "write", edit: "edit", bash: "bash",
};

const MODELS = buildModels(getBundledModelSlice("anthropic"));
let providerSettings: NonNullable<Config["provider"]> = {};
let longContextSettings: LongContextSettings = { plan: "pro", longContextExtraUsage: false, contextWindow: "auto" };

function resolveModel(input: string) {
	return _resolveModel(MODELS, input);
}

// --- Error handling ---

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (err && typeof err === "object") {
		const obj = err as Record<string, unknown>;
		if (typeof obj.message === "string") return obj.message;
		if (typeof obj.error === "string") return obj.error;
		try { return JSON.stringify(err); } catch {}
	}
	return String(err);
}

// AskClaude mode presets — controls which CC tools are blocked per mode.
// Only block tools that can't work (no OMP TUI for user interaction).
// Other CC tools (Agent, SendMessage, RemoteTrigger, Tasks, etc.) are intentionally not blocked.
const ASKCLAUDE_ALWAYS_BLOCKED = [
	"AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
	"ToolSearch", // probes for blocked tools, wastes tokens
	"ScheduleWakeup", // no harness to fire wakeup from inside a delegated subagent
];
const MODE_DISALLOWED_TOOLS: Record<string, string[]> = {
	full: [
		...ASKCLAUDE_ALWAYS_BLOCKED,
	],
	read: [
		...ASKCLAUDE_ALWAYS_BLOCKED,
		"Write", "Edit", "Bash", "NotebookEdit",
		"EnterWorktree", "ExitWorktree", "CronCreate", "CronDelete", "TeamCreate", "TeamDelete",
	],
	none: [
		...ASKCLAUDE_ALWAYS_BLOCKED,
		"Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent",
		"NotebookEdit", "EnterWorktree", "ExitWorktree",
		"CronCreate", "CronDelete", "TeamCreate", "TeamDelete",
		"WebFetch", "WebSearch",
	],
};


// Pi doesn't pass tool results directly — it appends them to the context and calls
// the provider again. classifyRequest extracts them; this logs what it found.
function debugToolResults(context: Context, results: McpResult[]): void {
	debug(`extractAllToolResults: ${results.length} results from ${context.messages.length} msgs`);
	debug(`extractAllToolResults: all msg roles:`, context.messages.map((m, i) => `[${i}]${m.role}`).join(" "));
	for (let r = 0; r < results.length; r++) {
		debug(`extractAllToolResults: result[${r}] id=${results[r].toolCallId}${results[r].isError ? " ERROR" : ""} preview:`, JSON.stringify(results[r].content).slice(0, 150));
	}
}

/** Extract the last user/developer message from context as a prompt string. */
function extractUserPrompt(messages: Context["messages"]): string | null {
	const last = messages[messages.length - 1];
	if (!last || !isPromptRole(last.role)) return null;
	if (typeof last.content === "string") return last.content;
	return messageContentToText(last.content) || "";
}

/** Extract the last user/developer message as ContentBlockParam[] (preserving images).
 *  Returns null if no images — caller should fall back to string prompt. */
function extractUserPromptBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	const last = messages[messages.length - 1];
	if (!last || !isPromptRole(last.role)) return null;
	if (typeof last.content === "string") {
		debug(`extractUserPromptBlocks: content is string (length=${last.content.length})`);
		return null;
	}
	if (!Array.isArray(last.content)) {
		debug(`extractUserPromptBlocks: content is ${typeof last.content}`);
		return null;
	}
	debug(`extractUserPromptBlocks: ${last.content.length} blocks, types=${last.content.map((b: any) => b.type).join(",")}`);
	let hasImage = false;
	const blocks: ContentBlockParam[] = [];
	for (const block of last.content) {
		if (block.type === "text" && block.text) {
			blocks.push({ type: "text", text: block.text });
		} else if (block.type === "image") {
			debug(`image block: mimeType=${(block as any).mimeType}, data length=${((block as any).data ?? "").length}, keys=${Object.keys(block).join(",")}`);
			if (!(block as any).data || !(block as any).mimeType) {
				debug(`image block missing data or mimeType, skipping`);
				continue;
			}
			hasImage = true;
			blocks.push({
				type: "image",
				source: { type: "base64", media_type: block.mimeType as Base64ImageSource["media_type"], data: block.data },
			});
		}
	}
	return hasImage ? blocks : null;
}

async function* wrapPromptStream(content: SDKUserMessage["message"]["content"], uuid?: string): AsyncIterable<SDKUserMessage> {
	const message: SDKUserMessage = {
		type: "user",
		message: { role: "user", content },
		parent_tool_use_id: null,
		...(uuid ? { uuid: uuid as SDKUserMessage["uuid"] } : {}),
	};
	yield message;
}

function newAssistantOutput(model: Model<any>, text: string, stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

function systemPromptText(systemPrompt: Context["systemPrompt"]): string | undefined {
	return systemPrompt?.join("\n\n");
}


function extractIsolatedSummaryPrompt(messages: Context["messages"]): string {
	if (messages.length !== 1 || messages[0].role !== "user") {
		throw new Error(
			`isolatedStreamFn: expected exactly 1 user message, got ${messages.length} ` +
			`(${messages.map((m) => m.role).join(",")})`,
		);
	}
	const promptText = extractUserPrompt(messages);
	if (!promptText) throw new Error("isolatedStreamFn: summarization prompt is empty");
	return promptText;
}

function resultErrorText(message: SDKResultMessage): string {
	const text = message.subtype === "success" ? message.result : message.errors?.join("\n");
	if (text) return text;
	if ("error" in message && typeof message.error === "string" && message.error) return message.error;
	return `Claude Code failed: ${message.subtype === "success" ? "SDK reported an error" : message.subtype}`;
}

function isolatedStreamFn(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void runIsolatedSummary(model, context, options, stream);
	return stream;
}

const isolatedCompleteImpl = (
	model: Parameters<typeof isolatedStreamFn>[0],
	context: Context,
	options: SimpleStreamOptions,
): Promise<AssistantMessage> => isolatedStreamFn(model, context, options).result();

async function runIsolatedSummary(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	let sdkQuery: ReturnType<typeof query> | undefined;
	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		void sdkQuery?.interrupt().catch(() => {});
		try { sdkQuery?.close(); } catch {}
	};

	try {
		const promptText = extractIsolatedSummaryPrompt(context.messages);
		const cwd = options?.cwd ?? process.cwd();
		const claudeExecutable = loadConfig(cwd).provider?.pathToClaudeCodeExecutable;
		const cliModel = claudeCodeModelId(model, longContextSettings);
		const effort = !options?.disableReasoning && options?.reasoning
			? claudeCodeEffort(model, options.reasoning)
			: undefined;
		debug(`compact summary: spawn model=${cliModel} registeredModel=${model.id} effort=${effort ?? "default"} promptLen=${promptText.length}`);

		sdkQuery = query({
			prompt: promptText,
			options: {
				cwd,
				env: { ...process.env, ...CC_CHILD_ENV, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
				settings: buildSdkSettings(),
				tools: [],
				strictMcpConfig: true,
				settingSources: [] as SettingSource[],
				skills: [],
				persistSession: false,
				systemPrompt: systemPromptText(context.systemPrompt),
				...(options?.disableReasoning ? { thinking: { type: "disabled" } } : effort ? { effort } : {}),
				model: cliModel,
				maxTurns: 1,
				...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
				...makeCliDebugOptions("compact-summary"),
			},
		});

		if (options?.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		let assistantText = "";
		let finalText = "";
		let errorText: string | undefined;
		let firstEventLogged = false;

		for await (const message of sdkQuery) {
			if (!firstEventLogged) {
				debug(`compact summary: first event type=${message.type}`);
				firstEventLogged = true;
			}
			if (wasAborted) break;

			if (message.type === "assistant") {
				for (const block of (message as any).message?.content ?? []) {
					if (block.type === "text" && typeof block.text === "string") assistantText += block.text;
				}
			} else if (message.type === "result") {
				logServedContextWindow("compact summary", message, model);
				if (message.subtype === "success" && !message.is_error) {
					finalText = message.result || assistantText;
				} else {
					errorText = resultErrorText(message);
				}
			}
		}

		if (wasAborted) {
			const output = newAssistantOutput(model, "", "aborted", "Operation aborted");
			debug("compact summary: aborted");
			stream.push({ type: "error", reason: "aborted", error: output });
			stream.end();
			return;
		}

		const text = finalText || assistantText;
		if (errorText || !text.trim()) {
			const msg = errorText ?? "Claude Code summary returned empty text";
			debug(`compact summary: error ${msg}`);
			stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", msg) });
			stream.end();
			return;
		}

		debug(`compact summary: done textLen=${text.length}`);
		stream.push({ type: "done", reason: "stop", message: newAssistantOutput(model, text, "stop") });
		stream.end();
	} catch (err) {
		const msg = errorMessage(err);
		debug("runIsolatedSummary threw; pushing terminal error", err);
		stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", msg) });
		stream.end();
	} finally {
		options?.signal?.removeEventListener("abort", onAbort);
		try { sdkQuery?.close(); } catch {}
	}
}

function reinjectPriorCompactionFileOps(branchEntries: Array<{ type: string; details?: unknown }>, preparation: { fileOps: { read: Set<string>; edited: Set<string> } }): void {
	const prior = [...branchEntries]
		.reverse()
		.find((entry): entry is CompactionEntry => entry.type === "compaction");
	const details = prior?.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
	if (!Array.isArray(details?.readFiles) || !Array.isArray(details?.modifiedFiles)) return;
	for (const file of details.readFiles) preparation.fileOps.read.add(String(file));
	for (const file of details.modifiedFiles) preparation.fileOps.edited.add(String(file));
	debug(`compact takeover: re-injected prior file ops read=${details.readFiles.length} modified=${details.modifiedFiles.length}`);
}

// Read the session file we just wrote and sanity-check it. Warns instead of
// throwing — CC may be more tolerant than our checks, so a false positive
// shouldn't block the user. Pure logic is in session-verify.js; this wrapper
// fans each warning out to debug log + piUI notify + diagDump.
function verifyWrittenSession(
	jsonlPath: string,
	expectedSessionId: string,
	expectedRecordCount: number,
	cwd: string,
): void {
	const warnings = _verifyWrittenSession(jsonlPath, expectedSessionId, expectedRecordCount);
	for (const msg of warnings) {
		debug(`WARNING session verify: ${msg}`);
		piUI?.notify(
			`Session file issue: ${msg}\n` +
			`cwd=${cwd} realpath=${safeRealpath(cwd)} CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"}\n` +
			`Please copy and paste this message into a new issue at https://github.com/its-a-unixsystem/omp-advanced-claude-bridge/issues/new` +
			(DEBUG ? ` and attach ${DEBUG_LOG_PATH}` : ` (rerun with CLAUDE_BRIDGE_DEBUG=1 to capture a debug log)`),
			"warning",
		);
		diagDump("session_verify_fail", { msg, jsonlPath, cwd, realpath: safeRealpath(cwd), claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null });
	}
	if (DEBUG) debugSessionPaths(expectedSessionId.slice(0, 8), cwd, jsonlPath);
}

function safeRealpath(p: string): string {
	try { return realpathSync(p); } catch (e) { return `<failed: ${(e as Error).message}>`; }
}

// Diagnostic snapshot of where a session file was just written. Catches the
// class of bugs where pi writes to ~/.claude/projects/<X> but CC SDK reads
// from ~/.claude/projects/<Y> (symlinks, CLAUDE_CONFIG_DIR, hash mismatch).
function debugSessionPaths(label: string, cwd: string, jsonlPath: string): void {
	const realCwd = safeRealpath(cwd);
	let fileSize: number | null = null;
	let fileExists = false;
	try {
		const st = statSync(jsonlPath);
		fileExists = true;
		fileSize = st.size;
	} catch { /* file may not exist yet */ }
	debug(`${label}: cwd=${cwd}`);
	if (realCwd !== cwd) debug(`${label}: realpath(cwd)=${realCwd} (DIFFERS — symlink-resolved path is what CC SDK uses)`);
	debug(`${label}: jsonlPath=${jsonlPath}`);
	debug(`${label}: fileExists=${fileExists}${fileSize != null ? ` size=${fileSize}` : ""}`);
	debug(`${label}: env.CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"} HOME=${process.env.HOME ?? "(unset)"}`);
}
// --- Provider helpers: tool name mapping ---

function mapToolName(name: string, customToolNameToPi?: Map<string, string>): string {
	const normalized = name.toLowerCase();
	const builtin = SDK_TO_PI_TOOL_NAME[normalized];
	if (builtin) return builtin;
	if (customToolNameToPi) {
		const mapped = customToolNameToPi.get(name) ?? customToolNameToPi.get(normalized);
		if (mapped) return mapped;
	}
	if (normalized.startsWith(MCP_TOOL_PREFIX)) return name.slice(MCP_TOOL_PREFIX.length);
	return name;
}

// Renames for Claude Code SDK param names that differ from pi's native names.
// Keys not listed here pass through unchanged, so new pi params work automatically.
const SDK_KEY_RENAMES: Record<string, Record<string, string>> = {
	read:  { file_path: "path" },
	write: { file_path: "path" },
	edit:  { file_path: "path", old_string: "oldText", new_string: "newText", old_text: "oldText", new_text: "newText" },
};

// Maps SDK tool args to pi tool args via key renaming + pass-through.
// Pi's own prepareArguments hooks handle any structural transforms (e.g. edit oldText/newText → edits[]).
function mapToolArgs(
	toolName: string, args: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const input = args ?? {};
	const renames = SDK_KEY_RENAMES[toolName.toLowerCase()];
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		const piKey = renames?.[key] ?? key;
		if (!(piKey in result)) result[piKey] = value; // first alias wins
	}
	// Pi bash has no default timeout; add a safety default
	if (toolName.toLowerCase() === "bash" && result.timeout == null) {
		result.timeout = 120;
	}
	return result;
}

// --- Provider helpers: tool resolution ---

// --- Provider helpers: tool bridge ---

// --- Query state ---
// Each BridgeSession (bridge-session.js) owns its QueryContexts (query-state.js);
// classifyRequest (request-kind.js) routes requests to them. They live in their
// own modules so tests can import them without activating the extension.

// Global (not query state):
let piUI: ExtensionUIContext | null = null;

function resolveMcpTools(context: Context, excludeToolName?: string): {
	mcpTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
} {
	const mcpTools: Tool[] = [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();

	if (!context.tools) return { mcpTools, customToolNameToSdk, customToolNameToPi };

	for (const tool of context.tools) {
		if (tool.name === excludeToolName) continue;
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		mcpTools.push(tool);
		customToolNameToSdk.set(tool.name, sdkName);
		customToolNameToSdk.set(tool.name.toLowerCase(), sdkName);
		customToolNameToPi.set(sdkName, tool.name);
		customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
	}

	return { mcpTools, customToolNameToSdk, customToolNameToPi };
}

// Creates an MCP server that bridges pi tools to the SDK. Each tool handler
// blocks on a Promise until pi delivers the tool result via streamSimple.
// Handlers are assigned toolCallIds from turnToolCallIds (populated when the SDK
// emits tool_use blocks). Results are matched by ID, not position.
// Handlers close over the captured `queryCtx`, ensuring they operate on the
// correct query's state while multiple queries run concurrently.
function buildMcpServers(tools: Tool[], queryCtx: QueryContext): Record<string, ReturnType<typeof createSdkMcpServer>> | undefined {
	if (!tools.length) return undefined;
	const mcpTools = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: jsonSchemaToZodShape(toolWireSchema(tool)),
		handler: async () => {
			const toolCallId = queryCtx.turnToolCallIds[queryCtx.nextHandlerIdx++];
			if (!toolCallId) debug(`WARNING: mcp handler ${tool.name} has no toolCallId (idx=${queryCtx.nextHandlerIdx - 1}, available=${queryCtx.turnToolCallIds.length})`);
			if (toolCallId && queryCtx.pendingResults.has(toolCallId)) {
				const result = queryCtx.pendingResults.get(toolCallId)!;
				queryCtx.pendingResults.delete(toolCallId);
				debug(`mcp handler: ${tool.name} [${toolCallId}] → resolved from queue (${queryCtx.pendingResults.size} remaining)`);
				return result;
			}
			debug(`mcp handler: ${tool.name} [${toolCallId}] → waiting`);
			return new Promise<McpResult>((resolve) => {
				queryCtx.pendingToolCalls.set(toolCallId, { toolName: tool.name, resolve });
			});
		},
	}));
	const server = createSdkMcpServer({ name: MCP_SERVER_NAME, version: "1.0.0", tools: mcpTools });
	return { [MCP_SERVER_NAME]: server };
}

// --- Usage helpers ---

function updateUsage(output: AssistantMessage, usage: Record<string, number | undefined>, model: Model<any>): void {
	if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
	if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
	if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
	if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
	// Claude Code may report reasoning/thinking tokens separately, while pi's Usage type does not model that field.
	const reasoning = usage.reasoning_tokens ?? usage.thinking_tokens;
	if (reasoning != null) (output.usage as typeof output.usage & { reasoning?: number }).reasoning = reasoning;
	output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	calculateCost(model, output.usage);
	const promptTokens = output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
	const cachePct = promptTokens > 0 ? Math.round(output.usage.cacheRead / promptTokens * 100) : 0;
	const reasoningText = reasoning != null ? ` reasoning=${reasoning}` : "";
	debug(`usage: in=${output.usage.input} out=${output.usage.output} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} total=${output.usage.totalTokens}${reasoningText} cachePct=${cachePct}% model=${model.id}`);
}

// Log the *served* context window reported by an SDK result message
// (modelUsage[id].contextWindow), which can differ from the window pi
// registered (model.contextWindow) when the runtime entitlement doesn't
// match the docs — e.g. bare Opus served 200K on Pro, or [1m] not honored.
// The result message's modelUsage is otherwise discarded; this makes the
// gap observable. See issue #18.
function logServedContextWindow(label: string, message: SDKMessage, model: Model<any>): void {
	const modelUsage = (message as any).modelUsage as Record<string, { contextWindow?: number; maxOutputTokens?: number }> | undefined;
	if (!modelUsage) return;
	for (const [k, v] of Object.entries(modelUsage)) {
		debug(`${label}: served contextWindow=${v.contextWindow ?? "?"} maxOutputTokens=${v.maxOutputTokens ?? "?"} servedModel=${k} registered=${model.contextWindow}`);
	}
}

// --- Provider helpers: misc ---

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use": return "toolUse";
		case "max_tokens": return "length";
		case "end_turn": default: return "stop";
	}
}

function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
	if (!input) return fallback;
	try { return JSON.parse(input); } catch { return fallback; }
}


// --- Provider: streaming function ---
//
// Push-based streaming with MCP tool bridge:
// 1. streamSimple starts a query() and kicks off consumeQuery() in background
// 2. consumeQuery() iterates the SDK generator, pushing events to currentPiStream
// 3. On tool_use: ends the current OMP stream, nulls it out. The MCP handler
//    blocks the generator naturally — no events arrive until resolved.
// 4. Pi executes the tool, calls streamSimple again. We swap in the new stream,
//    resolve the MCP handler, and the generator unblocks — events flow to new stream.
//
// Note: resetTurnState clears turnSawStreamEvent while the generator may still
// have queued messages from the previous turn. Step 3 nulls currentPiStream, so
// leftovers that arrive before the tool result hit the `!queryCtx.currentPiStream`
// guard in consumeQuery. A fast tool can deliver its result first, though, so
// processAssistantMessage also skips messages already seen as stream events.

function claimCurrentPiStream(stream: AssistantMessageEventStream, label: string, c: QueryContext): void {
	if (c.currentPiStream && !c.currentPiStream.done) {
		debug(`WARNING: currentPiStream overwritten before terminal event (${label}); pendingHandlers=${c.pendingToolCalls.size}`);
	}
	c.currentPiStream = stream;
}

function ensureTurnStarted(c: QueryContext): void {
	if (!c.turnStarted && c.currentPiStream && c.turnOutput) {
		c.currentPiStream!.push({ type: "start", partial: c.turnOutput });
		c.turnStarted = true;
	}
}

function finalizeCurrentStream(c: QueryContext, stopReason?: string): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	debug(`provider: finalizeCurrentStream called, stopReason=${stopReason}, turnOutput=${JSON.stringify({stopReason: c.turnOutput!.stopReason, error: c.turnOutput!.errorMessage})}`);
	if (!c.turnStarted) ensureTurnStarted(c);
	const reason = stopReason === "length" ? "length" : "stop";
	const stream = c.currentPiStream;
	stream!.push({ type: "done", reason, message: c.turnOutput });
	stream!.end();
	c.currentPiStream = null;
}

function failCurrentStream(c: QueryContext, reason: "aborted" | "error", errorMessage: string): void {
	const stream = c.currentPiStream;
	if (!stream || !c.turnOutput) return;
	c.turnOutput.stopReason = reason;
	c.turnOutput.errorMessage = errorMessage;
	stream.push({ type: "error", reason, error: c.turnOutput });
	stream.end();
	c.currentPiStream = null;
}

/** Maps Anthropic stream events to OMP stream events (text, thinking, toolcall).
 *  On message_stop with tool_use: ends currentPiStream so pi can execute the tool. */
function processStreamEvent(
	message: SDKMessage,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	c: QueryContext,
): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	c.turnSawStreamEvent = true;
	const event = (message as SDKMessage & { event: any }).event;

	if (event?.type === "message_start") {
		if (event.message?.id) c.streamedMessageIds.add(event.message.id);
		c.turnToolCallIds = [];
		c.nextHandlerIdx = 0;
		if (event.message?.usage) updateUsage(c.turnOutput, event.message.usage, model);
		return;
	}

	if (event?.type === "content_block_start") {
		ensureTurnStarted(c);
		if (event.content_block?.type === "text") {
			c.turnBlocks.push({ type: "text", text: "", index: event.index });
			c.currentPiStream!.push({ type: "text_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else if (event.content_block?.type === "thinking") {
			c.turnBlocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
			c.currentPiStream!.push({ type: "thinking_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else if (event.content_block?.type === "tool_use") {
			c.turnSawToolCall = true;
			c.turnToolCallIds.push(event.content_block.id);
			c.turnBlocks.push({
				type: "toolCall", id: event.content_block.id,
				name: mapToolName(event.content_block.name, customToolNameToPi),
				arguments: (event.content_block.input as Record<string, unknown>) ?? {},
				partialJson: "", index: event.index,
			});
			c.currentPiStream!.push({ type: "toolcall_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else {
			debug("processStreamEvent: unhandled content_block_start type", event.content_block?.type);
		}
		return;
	}

	if (event?.type === "content_block_delta") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		if (event.delta?.type === "text_delta" && block.type === "text") {
			block.text += event.delta.text;
			c.currentPiStream!.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: c.turnOutput });
		} else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
			block.thinking += event.delta.thinking;
			c.currentPiStream!.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: c.turnOutput });
		} else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
			block.partialJson += event.delta.partial_json;
			block.arguments = parsePartialJson(block.partialJson, block.arguments);
			c.currentPiStream!.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: c.turnOutput });
		} else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
			block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
		} else {
			debug("processStreamEvent: unhandled content_block_delta type", event.delta?.type);
		}
		return;
	}

	if (event?.type === "content_block_stop") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		delete block.index;
		if (block.type === "text") {
			c.currentPiStream!.push({ type: "text_end", contentIndex: index, content: block.text, partial: c.turnOutput });
		} else if (block.type === "thinking") {
			c.currentPiStream!.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: c.turnOutput });
		} else if (block.type === "toolCall") {
			c.turnSawToolCall = true;
			block.arguments = mapToolArgs(
				block.name, parsePartialJson(block.partialJson, block.arguments),
			);
			delete block.partialJson;
			c.currentPiStream!.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: c.turnOutput });
		}
		return;
	}

	if (event?.type === "message_delta") {
		c.turnOutput.stopReason = mapStopReason(event.delta?.stop_reason);
		if (event.usage) updateUsage(c.turnOutput, event.usage, model);
		return;
	}

	if (event?.type === "message_stop" && c.turnSawToolCall) {
		// Tool call complete — end this OMP stream. The SDK will still yield an
		// assistant message for this turn, but currentPiStream=null causes
		// consumeQuery to skip it. The MCP handler blocks the generator until
		// pi delivers the tool result via the next streamSimple call.
		c.turnOutput.stopReason = "toolUse";
		const stream = c.currentPiStream;
		stream!.push({ type: "done", reason: "toolUse", message: c.turnOutput });
		stream!.end();
		c.currentPiStream = null;

		// The next streamSimple call (tool result delivery) records the
		// post-tool-result history as this query's synced history.
		return;
	}

	if (event?.type !== "message_stop" && event?.type !== "ping") {
		debug("processStreamEvent: unhandled event type", event?.type);
	}
}

// The SDK always yields `assistant` messages (completed content blocks) after streaming.
// When stream_events already delivered the content, this is a no-op. But after
// resetTurnState (e.g. tool result delivery), if the next turn's assistant message
// arrives before any stream_events, this is the primary content path. Must maintain
// the same stream lifecycle as processStreamEvent — including ending the stream on
// tool_use to prevent deadlock with the MCP handler.
function processAssistantMessage(message: SDKMessage, model: Model<any>, customToolNameToPi: Map<string, string>, c: QueryContext): void {
	const assistantMsg = (message as any).message;
	if (!assistantMsg?.content) return;
	for (const block of assistantMsg.content) {
		if (block.type === "text" && typeof block.text === "string" && isSessionLimitNotice(block.text)) {
			throw new Error(describeRateLimitFailure(c.lastRateLimitRejection ?? {}, block.text.trim()));
		}
	}
	// Claude Code reports API failures and quota/context notices as `<synthetic>`
	// assistant messages. Keep their text off the stream so pre-output fallback
	// chains can still switch providers when the error result arrives.
	if (assistantMsg.model === "<synthetic>") {
		debug(`processAssistantMessage: <synthetic> message, keeping ${assistantMsg.content.length} block(s) off the stream`);
		for (const block of assistantMsg.content) {
			if (block.type === "text" && block.text) c.turnBlocks.push({ type: "text", text: block.text });
		}
		if (assistantMsg.usage && c.turnOutput) updateUsage(c.turnOutput, assistantMsg.usage, model);
		return;
	}
	if (c.turnSawStreamEvent) return;
	if (assistantMsg.id && c.streamedMessageIds.has(assistantMsg.id)) {
		debug(`processAssistantMessage: skipping ${assistantMsg.id}, already streamed`);
		return;
	}
	c.turnToolCallIds = [];
	c.nextHandlerIdx = 0;
	debug(`processAssistantMessage fallback: ${assistantMsg.content.length} blocks, types=${assistantMsg.content.map((b: any) => b.type).join(",")}`);
	for (const block of assistantMsg.content) {
		if (block.type === "text" && block.text) {
			ensureTurnStarted(c);
			c.turnBlocks.push({ type: "text", text: block.text });
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: block.text, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: block.text, partial: c.turnOutput });
		} else if (block.type === "thinking") {
			ensureTurnStarted(c);
			c.turnBlocks.push({ type: "thinking", thinking: block.thinking ?? "", thinkingSignature: block.signature ?? "" });
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "thinking_start", contentIndex: idx, partial: c.turnOutput });
			if (block.thinking) c.currentPiStream?.push({ type: "thinking_delta", contentIndex: idx, delta: block.thinking, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "thinking_end", contentIndex: idx, content: block.thinking ?? "", partial: c.turnOutput });
		} else if (block.type === "tool_use") {
			ensureTurnStarted(c);
			c.turnSawToolCall = true;
			c.turnToolCallIds.push(block.id);
			const mappedArgs = mapToolArgs(mapToolName(block.name, customToolNameToPi), block.input);
			c.turnBlocks.push({
				type: "toolCall", id: block.id,
				name: mapToolName(block.name, customToolNameToPi),
				arguments: mappedArgs,
			});
			const idx = c.turnBlocks.length - 1;
			const toolBlock = c.turnBlocks[idx];
			c.currentPiStream?.push({ type: "toolcall_start", contentIndex: idx, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "toolcall_end", contentIndex: idx, toolCall: toolBlock as any, partial: c.turnOutput });
		} else {
			debug("processAssistantMessage: unhandled block type", block.type);
		}
	}
	if (assistantMsg.usage && c.turnOutput) updateUsage(c.turnOutput, assistantMsg.usage, model);

	// End the stream on tool_use, same as processStreamEvent's message_stop handler.
	if (c.turnSawToolCall && c.currentPiStream && c.turnOutput) {
		c.turnOutput.stopReason = "toolUse";
		const stream = c.currentPiStream;
		stream.push({ type: "done", reason: "toolUse", message: c.turnOutput });
		stream.end();
		c.currentPiStream = null;
	}
}

type PrimaryPersistence = { store: SessionStore; branchSource?: string };

function reportResponse(
	observe: NonNullable<SimpleStreamOptions["onResponse"]>, response: ProviderResponseMetadata, model: Model<any>, signal?: AbortSignal,
) {
	try {
		void Promise.resolve(observe(response, model, signal)).catch(error => debug("provider: onResponse failed", error));
	} catch (error) {
		debug("provider: onResponse failed", error);
	}
}

function bindResponseObserver(c: QueryContext, owner: BridgeSession | null, model: Model<any>, options?: SimpleStreamOptions) {
	const observe = options?.onResponse;
	c.receiveResponse = observe && (response => reportResponse(observe, response, model, options?.signal));
	if (owner?.pendingResponse && c.receiveResponse) {
		const response = owner.pendingResponse;
		owner.pendingResponse = undefined;
		c.receiveResponse(response);
	}
}

/** Background consumer: iterates the SDK generator, pushing events to currentPiStream.
 *  Runs until the query ends. Per turn, the SDK yields stream_events (deltas), then
 *  an assistant message (completed blocks). On tool_use, the stream is ended by
 *  whichever path handles it first (processStreamEvent or processAssistantMessage),
 *  and the MCP handler blocks the generator until pi delivers the tool result.
 *  With `endOnToolUse`, no tool result can come, so the tool-use turn is the last. */
async function consumeQuery(
	sdkQuery: Query,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	queryCtx: QueryContext,
	endOnToolUse: boolean,
	owner: BridgeSession | null,
): Promise<void> {
	for await (const message of sdkQuery) {
		if (queryCtx.aborted) break;
		if (message.type === "rate_limit_event") {
			const info = message.rate_limit_info;
			debug("consumeQuery: rate_limit_event", info);
			if (info.status === "rejected") {
				queryCtx.lastRateLimitRejection = { rateLimitType: info.rateLimitType, resetsAt: info.resetsAt };
			}
			const notice = rateLimitNotice(info);
			if (notice) piUI?.notify(notice.message, notice.level);
			const response = rateLimitResponse(info);
			if (queryCtx.currentPiStream && queryCtx.receiveResponse) queryCtx.receiveResponse(response);
			else if (owner && !owner.closed) owner.pendingResponse = response;
			continue;
		}
		if (message.type === "system" && message.subtype === "init") queryCtx.claudeSessionId = message.session_id;
		if (message.type === "result" && (message.subtype !== "success" || message.is_error)) {
			const failure = resultErrorText(message);
			throw new Error(queryCtx.lastRateLimitRejection
				? describeRateLimitFailure(queryCtx.lastRateLimitRejection, failure)
				: failure);
		}
		if (!queryCtx.currentPiStream || !queryCtx.turnOutput) continue;

		switch (message.type) {
			case "stream_event":
				processStreamEvent(message, customToolNameToPi, model, queryCtx);
				break;
			case "assistant":
				processAssistantMessage(message, model, customToolNameToPi, queryCtx);
				break;
			case "result":
				logServedContextWindow("result", message, model);
				if (!queryCtx.turnSawStreamEvent && !queryCtx.turnBlocks.length && message.subtype === "success") {
					ensureTurnStarted(queryCtx);
					const text = message.result || "";
					queryCtx.turnBlocks.push({ type: "text", text });
					const idx = queryCtx.turnBlocks.length - 1;
					queryCtx.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: queryCtx.turnOutput });
					queryCtx.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: text, partial: queryCtx.turnOutput });
					queryCtx.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: text, partial: queryCtx.turnOutput });
				}
				break;
			case "system":
			case "user":
				break;
			default:
				debug("consumeQuery: unhandled SDK message type", message.type);
				break;
		}
		if (endOnToolUse && !queryCtx.currentPiStream && queryCtx.turnOutput.stopReason === "toolUse") break;
	}

	debug(`consumeQuery: for-await loop exited, aborted=${queryCtx.aborted}, session=${queryCtx.claudeSessionId?.slice(0, 8) ?? "none"}`);
}

/** Provider entry point. Pi calls this for each new prompt and each tool result.
 *  classifyRequest decides what the request is, within the session it owns. */
function streamClaudeAgentSdk(
	model: Model<any>,
	context: Context,
	excludeToolName: string,
	options?: SimpleStreamOptions,
	persistence?: PrimaryPersistence,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const owner = bridgeSession(options?.sessionId, options?.providerSessionState);
	const request = classifyRequest(context.messages, owner);
	const lastMsgRole = context.messages[context.messages.length - 1]?.role;
	debug(`provider: streamClaudeAgentSdk called, session=${owner?.id ?? "none"}, kind=${request.kind}, lastMsgRole=${lastMsgRole}, liveQueries=${owner?.queries.size ?? 0}`);

	switch (request.kind) {
		case "tool-results":
			deliverToolResults(stream, model, context, request, owner, options);
			break;
		case "orphaned-result":
			if (owner?.pendingResponse && options?.onResponse) {
				const response = owner.pendingResponse;
				owner.pendingResponse = undefined;
				reportResponse(options.onResponse, response, model, options.signal);
			}
			finishOrphanedToolResult(stream, model);
			break;
		case "turn":
		case "helper":
			startProviderQuery(stream, model, context, owner, excludeToolName, options, persistence);
			break;
	}
	return stream;
}

// Pi appends tool results to context and calls back. Match this turn's results
// (everything after the last assistant message) against the waiting MCP
// handlers of the query that issued them. Results that arrive before their
// handler get queued in pendingResults.
function deliverToolResults(
	stream: AssistantMessageEventStream,
	model: Model<any>,
	context: Context,
	{ query: resultCtx, results, steer }: Extract<RequestKind<QueryContext>, { kind: "tool-results" }>,
	owner: BridgeSession | null,
	options?: SimpleStreamOptions,
): void {
	debugToolResults(context, results);
	claimCurrentPiStream(stream, "tool-result", resultCtx);
	resultCtx.resetTurnState(model);
	bindResponseObserver(resultCtx, owner, model, options);
	debug(`provider: tool results, ${results.length} results, ${resultCtx.pendingToolCalls.size} waiting handlers, ctx.msgs=${context.messages.length}`);
	for (const result of results) {
		const id = result.toolCallId;
		if (id && resultCtx.pendingToolCalls.has(id)) {
			const pending = resultCtx.pendingToolCalls.get(id)!;
			resultCtx.pendingToolCalls.delete(id);
			debug(`provider: resolving ${pending.toolName} [${id}]${result.isError ? " (error)" : ""}`, JSON.stringify(result.content).slice(0, 200));
			pending.resolve(result);
		} else if (id) {
			resultCtx.pendingResults.set(id, result);
			debug(`provider: queued result [${id}] (${resultCtx.pendingResults.size} pending)`);
		} else {
			debug(`WARNING: tool result without toolCallId, cannot match`);
		}
		if (resultCtx.pendingToolCalls.size > 0 && resultCtx.pendingResults.size > 0) {
			debug(`BUG: both maps non-empty! handlers=${resultCtx.pendingToolCalls.size} results=${resultCtx.pendingResults.size}`);
		}
	}
	if (resultCtx.pendingToolCalls.size > 0) {
		debug(`WARNING: ${resultCtx.pendingToolCalls.size} MCP handlers still waiting after delivering ${results.length} results`);
		piUI?.notify(`Claude bridge: ${resultCtx.pendingToolCalls.size} tool handler(s) still waiting — provider may be stuck`, "warning");
	}

	// Pi can append a steer while a tool is executing or a follow-up between
	// tool-result turns. We can't forward it mid-query, so replay it after
	// the SDK iteration ends.
	if (steer) {
		const prompt = extractUserPromptBlocks(context.messages) ?? extractUserPrompt(context.messages);
		if (prompt) {
			resultCtx.deferredUserMessages.push(prompt);
			debug(`provider: deferred user message for replay after query: ${typeof prompt === "string" ? prompt.slice(0, 60) : "[multimodal]"}`);
		}
	}

	// The initial prompt is already sent. Later contexts add the OMP tool
	// calls/results; if they include a steer, native alignment stops there.
	resultCtx.history = [...resultCtx.history.slice(0, 1), ...context.messages.slice(resultCtx.historyStart + 1)];
}

// The query is gone but pi still delivered the result. End the turn without
// touching sync state: whether the CC session holds the result is unknown,
// so the next turn checks the history and rebuilds if needed.
function finishOrphanedToolResult(stream: AssistantMessageEventStream, model: Model<any>): void {
	debug(`provider: orphaned tool result after abort, emitting end_turn`);
	queueMicrotask(() => {
		stream.push({ type: "done", reason: "stop", message: newAssistantOutput(model, "", "stop") });
		stream.end();
	});
}

// Set up a new agent turn or a helper. A helper owns no session to sync and
// starts in a clean CC session that the query lifecycle deletes on exit.
function startProviderQuery(
	stream: AssistantMessageEventStream,
	model: Model<any>,
	context: Context,
	owner: BridgeSession | null,
	excludeToolName: string,
	options?: SimpleStreamOptions,
	persistence?: PrimaryPersistence,
): void {
	const helper = owner === null;
	const queryCtx = new QueryContext();
	debug(`provider: fresh query setup, helper=${helper}, session=${owner?.id ?? "none"}, liveQueries=${owner?.queries.size ?? 0}`);
	claimCurrentPiStream(stream, "fresh-query", queryCtx);
	queryCtx.resetTurnState(model);
	if (options?.signal?.aborted) {
		failCurrentStream(queryCtx, "aborted", "Operation aborted");
		return;
	}
	bindResponseObserver(queryCtx, owner, model, options);

	const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context, excludeToolName);
	const cwd = options?.cwd ?? process.cwd();
	const providerPrompt = buildProviderPrompt(context.systemPrompt, providerSettings);
	const cliModel = claudeCodeModelId(model, longContextSettings);
	const transcript = owner?.beginTranscript(persistence);
	let base: SessionState | undefined;
	try {
		if (transcript) {
			queryCtx.historyStart = Math.max(0, context.messages.length - 1);
			queryCtx.history = context.messages.slice(queryCtx.historyStart);
			base = syncHistory(transcript.state, context.messages.slice(0, queryCtx.historyStart), cwd, providerPrompt.promptDigest,
				customToolNameToSdk, cliModel, verifyWrittenSession);
		}
	} catch (error) {
		transcript?.finish(transcript.state);
		failCurrentStream(queryCtx, "error", errorMessage(error));
		return;
	}
	const promptUuid = base ? randomUUID() : undefined;
	const resumeSessionId = base?.stamp ? base.sessionId : undefined;
	debug(`syncResult: path=${base && base === transcript?.state ? "reuse" : base?.stamp ? "import" : "clean-start"} sessionId=${base?.sessionId ?? "none"}`);
	const promptBlocks = extractUserPromptBlocks(context.messages);
	let promptText = extractUserPrompt(context.messages) ?? "";

	// Guard: empty prompt means the last context message isn't a user message.
	// This should never happen with per-query state — dump diagnostics if it does.
	if (!promptText && !promptBlocks) {
		diagDump("empty_prompt", {
			contextLength: context.messages.length,
			lastMsgRole: context.messages[context.messages.length - 1]?.role,
			kind: helper ? "helper" : "turn",
			liveQueries: owner?.queries.size ?? 0,
			session: base ? { sessionId: base.sessionId.slice(0, 8), messages: base.digests.length } : null,
			messageRoles: context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
		});
		// Recover: use a continuation prompt so the SDK doesn't send an empty text block
		promptText = "[continue]";
	}

	const prompt = promptUuid ? wrapPromptStream(promptBlocks ?? promptText, promptUuid)
		: promptBlocks ? wrapPromptStream(promptBlocks) : promptText;
	try {
		const mcpServers = buildMcpServers(mcpTools, queryCtx);
		const { queryOptions, effort, strictMcpConfigEnabled } =
			buildProviderQueryOptions(model, options, cwd, cliModel, mcpServers, providerPrompt, !helper && !options?.parentSessionId);
		debug("provider: fresh query",
			`model=${cliModel} msgs=${context.messages.length} tools=${mcpTools.length}`,
			`resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${effort ?? "default"}`,
			`appendSys=${providerPrompt.forwardsSystemPrompt} strictMcp=${strictMcpConfigEnabled}`,
			`prompt=${promptText.slice(0, 60)}${promptBlocks ? " [+images]" : ""}`);
		const sdkQuery = query({ prompt, options: {
			...queryOptions,
			...(resumeSessionId ? { resume: resumeSessionId } : base ? { sessionId: base.sessionId } : {}),
		} });
		queryCtx.claudeSessionId = base?.sessionId;
		runProviderQuery(sdkQuery, queryCtx, owner, transcript, model, customToolNameToPi, queryOptions, options?.signal, base, promptUuid);
	} catch (error) {
		transcript?.finish(base?.stamp ? { ...base, dirty: true } : transcript.state);
		failCurrentStream(queryCtx, "error", errorMessage(error));
	}
}

type ProviderQueryOptions = Options & { cwd: string; extraArgs: Record<string, string | null> };

function buildProviderQueryOptions(
	model: Model<any>,
	options: SimpleStreamOptions | undefined,
	cwd: string,
	cliModel: string,
	mcpServers: Options["mcpServers"],
	{ systemPrompt, settingSources, forwardsSystemPrompt }: ProviderPrompt,
	useProviderMemory: boolean,
) {
	const strictMcpConfigEnabled = providerSettings.strictMcpConfig !== false;
	const claudeExecutable = providerSettings.pathToClaudeCodeExecutable;

	const reasoning = options?.disableReasoning ? undefined : options?.reasoning;
	const effort = reasoning ? claudeCodeEffort(model, reasoning) : undefined;
	const extraArgs: Record<string, string | null> = { model: cliModel };
	if (strictMcpConfigEnabled) extraArgs["strict-mcp-config"] = null;
	// Summarize thinking so supported Opus models emit thinking_delta events.
	if (effort) extraArgs["thinking-display"] = "summarized";
	const queryOptions: ProviderQueryOptions = {
		cwd,
		env: { ...process.env, ...CC_CHILD_ENV },
		tools: [],
		permissionMode: "bypassPermissions",
		includePartialMessages: true,
		systemPrompt,
		settings: buildSdkSettings(useProviderMemory && providerSettings.autoMemoryEnabled === true, forwardsSystemPrompt),
		extraArgs,
		...(options?.disableReasoning ? { thinking: { type: "disabled" } } : effort ? { effort } : {}),
		...(settingSources ? { settingSources } : {}),
		...(mcpServers ? { mcpServers } : {}),
		...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
		...makeCliDebugOptions("provider"),
	};

	return { queryOptions, effort, strictMcpConfigEnabled };
}

function runProviderQuery(
	sdkQuery: Query,
	queryCtx: QueryContext,
	owner: BridgeSession | null,
	transcript: TranscriptLease | undefined,
	model: Model<any>,
	customToolNameToPi: Map<string, string>,
	queryOptions: ProviderQueryOptions,
	signal?: AbortSignal,
	base?: SessionState,
	promptUuid?: string,
): void {
	const helper = owner === null;
	// The query abort targets: sdkQuery, or the continuation replaying a steer.
	let runningQuery = sdkQuery;
	owner?.queries.add(queryCtx);

	// Every query ends here, once: aborted (its request's signal, or its session
	// closing), failed, or done after replaying its deferred steers. The end
	// takes the query out of its session and decides the sync state it leaves
	// behind before the stream's terminal event lets OMP send its next request.
	// An abort retires its transcript immediately: the subprocess may still
	// be flushing writes when the next turn starts.
	let ended = false;
	const forwardAbort = () => queryCtx.abort();
	const endQuery = (end: "done" | "aborted" | "error", error?: unknown) => {
		if (ended) return;
		ended = true;
		signal?.removeEventListener("abort", forwardAbort);
		queryCtx.deferredUserMessages = [];
		owner?.queries.delete(queryCtx);
		const { claudeSessionId, turnOutput, history, replayedSteer } = queryCtx;
		if (turnOutput && queryCtx.currentPiStream) history.push(turnOutput);
		const next = base && end === "done" && claudeSessionId === base.sessionId && promptUuid
			? recordTurn(base, promptUuid, history, !replayedSteer && queryCtx.currentPiStream !== null)
			: base?.stamp ? { ...base, dirty: true } : null;
		transcript?.finish(next);
		queryCtx.drainToolCalls(end === "aborted" ? "Operation aborted" : "Query ended");
		debug(`provider: query ended, end=${end}, helper=${helper}, session=${queryCtx.claudeSessionId?.slice(0, 8) ?? "none"}, stopReason=${queryCtx.turnOutput?.stopReason}${error === undefined ? "" : `, error=${errorMessage(error)}`}`);
		if (owner?.closed) debug(`provider: session ${owner.id} closed, sync state dropped`);
		else if (claudeSessionId && end === "aborted") debug(`provider: retired transcript ${claudeSessionId.slice(0, 8)} after abort`);
		else if (owner?.state && owner.state.sessionId === claudeSessionId) debug(`provider: synced session=${owner.state.sessionId.slice(0, 8)}, messages=${owner.state.digests.length}`);

		if (end === "aborted") {
			// Request a graceful interrupt, then close to unblock SDK iteration.
			// Interrupt alone lets the current API call finish.
			void runningQuery.interrupt().catch(() => {});
			try { runningQuery.close(); } catch {}
			failCurrentStream(queryCtx, "aborted", "Operation aborted");
		} else if (end === "error") {
			failCurrentStream(queryCtx, "error", errorMessage(error));
		} else {
			finalizeCurrentStream(queryCtx, queryCtx.turnOutput?.stopReason);
		}
	};
	queryCtx.signal.addEventListener("abort", () => endQuery("aborted"), { once: true });
	if (signal?.aborted) queryCtx.abort();
	else signal?.addEventListener("abort", forwardAbort, { once: true });

	consumeAndReplay(sdkQuery, queryCtx, model, customToolNameToPi, queryOptions, helper,
		(continuation) => { runningQuery = continuation; }, owner)
		.then(() => endQuery("done"), (error) => endQuery("error", error))
		.finally(() => {
			// Ephemeral helpers are deleted only once iteration has ended.
			if (helper && queryCtx.claudeSessionId) {
				deleteSession(queryCtx.claudeSessionId, queryOptions.cwd, process.env.CLAUDE_CONFIG_DIR);
				debug(`provider: deleted ephemeral helper session ${queryCtx.claudeSessionId.slice(0, 8)}`);
			}
		});
}

// After the first SDK iteration, replay deferred steers in the same CC
// session and OMP stream. A helper can't receive tool results, so its
// tool-use turn is its last.
async function consumeAndReplay(
	sdkQuery: Query,
	queryCtx: QueryContext,
	model: Model<any>,
	customToolNameToPi: Map<string, string>,
	queryOptions: ProviderQueryOptions,
	endOnToolUse: boolean,
	setRunningQuery: (continuation: Query) => void,
	owner: BridgeSession | null,
): Promise<void> {
	try {
		await consumeQuery(sdkQuery, customToolNameToPi, model, queryCtx, endOnToolUse, owner);
	} finally {
		sdkQuery.close();
	}
	while (queryCtx.deferredUserMessages.length > 0 && !queryCtx.aborted) {
		const steerPrompt = queryCtx.deferredUserMessages.shift()!;
		const resumeId = queryCtx.claudeSessionId;
		if (!resumeId) {
			debug(`WARNING: no session to resume for deferred message, dropping`);
			break;
		}
		queryCtx.replayedSteer = true;
		const preview = typeof steerPrompt === "string" ? steerPrompt.slice(0, 60) : "[multimodal]";
		queryCtx.resetTurnState(model);
		const contOptions = { ...queryOptions, resume: resumeId, ...makeCliDebugOptions("continuation") };
		const contQuery = query({ prompt: typeof steerPrompt === "string" ? steerPrompt : wrapPromptStream(steerPrompt), options: contOptions });
		setRunningQuery(contQuery);
		debug(`provider: continuation query, model=${queryOptions.extraArgs.model}, resume=${resumeId.slice(0, 8)}, prompt=${preview}`);
		try {
			await consumeQuery(contQuery, customToolNameToPi, model, queryCtx, false, owner);
		} finally {
			contQuery.close();
		}
	}
}

// --- AskClaude: prompt and wait ---

async function promptAndWait(
	prompt: string,
	mode: "full" | "read" | "none",
	toolCalls: Map<string, ToolCallState>,
	signal?: AbortSignal,
	options?: {
		systemPrompt?: string;
		appendSkills?: boolean;
		model?: string;
		thinking?: string;
		isolated?: boolean;
		context?: Context["messages"];
	},
): Promise<{ responseText: string; stopReason: string }> {
	if (signal?.aborted) throw new Error("Aborted");

	const cwd = process.cwd();
	const requestedModel = options?.model ?? "opus";
	const model = resolveModel(requestedModel);
	const modelId = model?.id ?? requestedModel;
	const cliModel = model ? claudeCodeModelId(model, longContextSettings) : modelId;

	// Shared mode imports OMP history into a disposable transcript rather than
	// writing to the provider's native conversation or its saved mapping.
	const context = !options?.isolated && options?.context?.length ? options.context : undefined;
	let imported: SessionState | undefined;
	let sdkQuery: Query | undefined;

	// Mode → disallowed tools
	const disallowedTools = MODE_DISALLOWED_TOOLS[mode] ?? [];

	// Skills append
	const skillsBlock = options?.appendSkills !== false && options?.systemPrompt
		? extractSkillsBlock(options.systemPrompt) : undefined;

	// Effort
	const effort = options?.thinking ? claudeCodeEffort(model ?? {}, options.thinking) : undefined;

	const claudeExecutable = providerSettings.pathToClaudeCodeExecutable;

	const extraArgs: Record<string, string | null> = {
		"strict-mcp-config": null,
		model: cliModel,
	};
	if (effort) extraArgs["thinking-display"] = "summarized";

	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		void sdkQuery?.interrupt().catch(() => { try { sdkQuery?.close(); } catch {} });
	};
	let responseText = "";
	let sdkMessageCount = 0;
	let resultSubtype: string | undefined;

	try {
		if (context) imported = syncHistory(null, context, cwd, "", undefined, modelId, verifyWrittenSession);
		const resumeSessionId = imported?.stamp ? imported.sessionId : undefined;
		debug("askClaude:",
			`mode=${mode} model=${modelId} cliModel=${cliModel} effort=${effort ?? "default"}`,
			`isolated=${options?.isolated ?? false} resume=${resumeSessionId?.slice(0, 8) ?? "none"}`,
			`skills=${Boolean(skillsBlock)} promptLen=${prompt.length}`);

		sdkQuery = query({
			prompt,
			options: {
				cwd,
				env: { ...process.env, ...CC_CHILD_ENV },
				settings: buildSdkSettings(),
				permissionMode: "bypassPermissions",
				...(disallowedTools.length ? { disallowedTools } : {}),
				...(effort ? { effort } : {}),
				systemPrompt: skillsBlock
					? { type: "preset", preset: "claude_code", append: skillsBlock }
					: undefined,
				settingSources: ["user", "project"] as SettingSource[],
				extraArgs,
				...(resumeSessionId ? { resume: resumeSessionId } : {}),
				persistSession: false,
				...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
				...makeCliDebugOptions("askclaude"),
			},
		});
		if (signal?.aborted) {
			onAbort();
			throw new Error("Aborted");
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		for await (const message of sdkQuery) {
			if (wasAborted) break;
			sdkMessageCount++;

			switch (message.type) {
				case "assistant": {
					// Track complete tool-use blocks for the action summary.
					for (const block of (message as any).message?.content ?? []) {
						if (block.type === "tool_use") {
							toolCalls.set(block.id, {
								name: mapToolName(block.name),
								rawInput: block.input,
							});
						}
					}
					break;
				}
				case "result": {
					resultSubtype = message.subtype;
					if (message.subtype !== "success" || message.is_error) throw new Error(resultErrorText(message));
					const r = message as any;
					if (r.usage) {
						debug(`askClaude: result usage: in=${r.usage.input_tokens} out=${r.usage.output_tokens} cacheRead=${r.usage.cache_read_input_tokens ?? 0} cacheWrite=${r.usage.cache_creation_input_tokens ?? 0} turns=${r.num_turns ?? "?"}`);
					}
					if (!responseText && message.result) {
						responseText = message.result;
					}
					break;
				}
			}
		}

		const stopReason = wasAborted ? "cancelled" : "stop";
		debug(`askClaude: done`,
			`stopReason=${stopReason} resultSubtype=${resultSubtype ?? "none"}`,
			`sdkMessages=${sdkMessageCount} responseLen=${responseText.length}`,
			`toolCalls=${toolCalls.size}`);
		return { responseText, stopReason };
	} finally {
		signal?.removeEventListener("abort", onAbort);
		sdkQuery?.close();
		if (imported?.stamp) deleteSession(imported.sessionId, imported.cwd, imported.claudeDir);
	}
}

// --- Extension registration ---

const DEFAULT_TOOL_DESCRIPTION_FULL = "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories), or to autonomously handle a task. Defaults to read-only mode — use full mode when the user wants to delegate a task that requires changes. Prefer to handle straightforward tasks yourself.";
const DEFAULT_TOOL_DESCRIPTION = "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories). Read-only — Claude Code can explore the codebase but not make changes. Prefer to handle straightforward tasks yourself.";

const PREVIEW_MAX_CHARS = 1000;
const PREVIEW_MAX_LINES = 6;

export default function (pi: ExtensionAPI) {
	// Disable non-essential Claude Code traffic (update checks, MCP registry, telemetry)
	process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

	const config = loadConfig(process.cwd());
	debug("loadConfig:", JSON.stringify(config));
	providerSettings = config.provider ?? {};
	const contextWindowSetting = providerSettings.contextWindow;
	const contextWindow: ContextWindowMode =
		contextWindowSetting === "auto" || contextWindowSetting === "1m" || contextWindowSetting === "200k"
			? contextWindowSetting
			: "auto";
	if (contextWindowSetting != null && contextWindow !== contextWindowSetting) {
		console.error(`${PROVIDER_ID}: invalid provider.contextWindow "${String(contextWindowSetting)}", using auto`);
	}
	longContextSettings = {
		plan: providerSettings.plan ?? "pro",
		longContextExtraUsage: providerSettings.longContextExtraUsage ?? false,
		contextWindow,
	};
	const registeredModels = buildVariantModels(MODELS, longContextSettings);

	const store = new SessionStore(join(getAgentDir(), "advanced-claude-bridge", "sessions"), error => debug("session store:", error));
	let primaryId: string | undefined;
	let branchSource: string | undefined;
	const setPrimary = (ctx: ExtensionContext, branch = false) => {
		if (ctx.agent.kind !== "main") return;
		piUI = ctx.ui;
		const next = ctx.sessionManager.getSessionFile() ? ctx.sessionManager.getSessionId() : undefined;
		if (next === primaryId) return;
		branchSource = branch ? primaryId : undefined;
		primaryId = next;
	};
	pi.on("session_start", (_event, ctx) => setPrimary(ctx));
	pi.on("session_switch", (event, ctx) => setPrimary(ctx, event.reason === "fork"));
	pi.on("session_branch", (_event, ctx) => setPrimary(ctx, true));
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		piUI = null;
		primaryId = branchSource = undefined;
	});
	pi.on("session_before_compact", async (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER_ID) return undefined;
		debug(
			`session_before_compact: takeover isSplitTurn=${event.preparation.isSplitTurn} ` +
			`messages=${event.preparation.messagesToSummarize.length} turnPrefix=${event.preparation.turnPrefixMessages.length}`,
		);
		try {
			reinjectPriorCompactionFileOps(event.branchEntries, event.preparation);
			const compaction = await compact(
				event.preparation,
				ctx.model,
				undefined,
				event.customInstructions,
				event.signal,
				{ completeImpl: isolatedCompleteImpl },
			);
			debug(`session_before_compact: takeover complete summaryLen=${compaction.summary.length}`);
			return { compaction };
		} catch (err) {
			const msg = errorMessage(err);
			debug("session_before_compact: takeover failed; cancelling to avoid native compact fallback", err);
			ctx.ui?.notify?.(
				`Claude bridge compact failed (${msg}); cancelled to avoid known hang. Retry, switch model, or reduce context.`,
				"error",
			);
			return { cancel: true };
		}
	});

	const askConf = config.askClaude;
	const askClaudeToolName = askConf?.name ?? "AskClaudeAdvanced";
	pi.registerProvider(PROVIDER_ID, {
		baseUrl: `https://${PROVIDER_ID}.invalid`,
		apiKey: "not-used",
		api: PROVIDER_ID,
		models: registeredModels,
		streamSimple: (model, context, options) => streamClaudeAgentSdk(
			model, context, askClaudeToolName, options,
			primaryId !== undefined && primaryId === options?.sessionId && !options.parentSessionId ? { store, branchSource } : undefined,
		),
	});

	// --- AskClaude tool ---

	const allowFull = askConf?.allowFullMode !== false;
	const configuredMode = askConf?.defaultMode ?? "read";
	const defaultMode = !allowFull && configuredMode === "full" ? "read" : configuredMode;
	const defaultIsolated = askConf?.defaultIsolated ?? false;

	const modeValues = allowFull ? ["read", "full", "none"] as const : ["read", "none"] as const;
	type AskClaudeToolParams = {
		prompt: string;
		mode?: "full" | "read" | "none";
		model?: string;
		thinking?: string;
		isolated?: boolean;
	};

	const readAskClaudeParams = (value: unknown, requirePrompt: boolean): AskClaudeToolParams => {
		if (!value || typeof value !== "object") {
			if (requirePrompt) throw new Error(`${askClaudeToolName} prompt must be a string`);
			return { prompt: "" };
		}
		if (!("prompt" in value) || typeof value.prompt !== "string") {
			if (requirePrompt) throw new Error(`${askClaudeToolName} prompt must be a string`);
			return { prompt: "" };
		}
		const parsed: AskClaudeToolParams = { prompt: value.prompt };
		if ("mode" in value && (value.mode === "full" || value.mode === "read" || value.mode === "none")) parsed.mode = value.mode;
		if ("model" in value && typeof value.model === "string") parsed.model = value.model;
		if ("thinking" in value && typeof value.thinking === "string") parsed.thinking = value.thinking;
		if ("isolated" in value && typeof value.isolated === "boolean") parsed.isolated = value.isolated;
		return parsed;
	};

	let modeDesc = `"read": questions about the codebase — review, analysis, explain. "none": general knowledge only (no file access). Default: "${defaultMode}".`;
	if (allowFull) modeDesc += ` "full": allows writing and bash execution (careful: runs without feedback to pi).`;

	if (askConf?.enabled !== false) {
		const z = pi.zod;
		const askClaudeParams = z.object({
			prompt: z.string().describe("The question or task for Claude Code. By default Claude sees the full conversation history. Don't research up front, let Claude explore."),
			mode: z.enum(modeValues).describe(modeDesc).optional(),
			model: z.string().describe('Claude model (e.g. "opus", "sonnet", "haiku", or full ID). Defaults to "opus".').optional(),
			thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).describe("Thinking effort level. Omit to use Claude Code's default.").optional(),
			isolated: z.boolean().describe("When true, Claude sees only this prompt (clean session). When false (default), Claude sees the full conversation history.").optional(),
		});
		pi.registerTool({
			name: askClaudeToolName,
			label: askConf?.label ?? "Ask Claude Code",
			description: askConf?.description ?? (allowFull ? DEFAULT_TOOL_DESCRIPTION_FULL : DEFAULT_TOOL_DESCRIPTION),
			parameters: askClaudeParams,
			loadMode: "essential",
			renderCall(args) {
				const params = readAskClaudeParams(args, false);
				const spans = [{ s: "mdLink strong", t: `${askClaudeToolName} ` }];
				const mode = params.mode ?? defaultMode;
				const tags: string[] = [];
				if (mode !== defaultMode) tags.push(`mode=${mode}`);
				if (params.model) tags.push(`model=${params.model}`);
				if (params.thinking) tags.push(`thinking=${params.thinking}`);
				if (params.isolated) tags.push("isolated");
				if (tags.length) spans.push({ s: "accent", t: `[${tags.join(", ")}] ` });
				const lines = params.prompt.slice(0, PREVIEW_MAX_CHARS).split("\n").slice(0, PREVIEW_MAX_LINES);
				spans.push({ s: "muted", t: `"${lines.join("\n")}"` });
				if (params.prompt.length > PREVIEW_MAX_CHARS || params.prompt.split("\n").length > PREVIEW_MAX_LINES) {
					spans.push({ s: "dim", t: " …" });
				}
				return jsx("text", { spans });
			},
			renderResult(result, { expanded, isPartial }) {
				if (isPartial) {
					const status = result.content[0]?.type === "text" ? result.content[0].text : "working...";
					return jsx("text", { spans: [{ s: "mdLink", t: "◉ Claude Code " }, { s: "muted", t: status }] });
				}

				const details = result.details as { prompt?: string; executionTime?: number; actions?: string; error?: boolean } | undefined;
				const body = result.content[0]?.type === "text" ? result.content[0].text : "";

				const spans = [details?.error
					? { s: "error", t: "✗ Claude Code error" }
					: { s: "mdLink", t: "✓ Claude Code" }];

				if (details?.executionTime) spans.push({ s: "dim", t: ` ${(details.executionTime / 1000).toFixed(1)}s` });
				if (details?.actions) spans.push({ s: "muted", t: ` ${details.actions}` });

				if (expanded) {
					if (details?.prompt) spans.push({ s: "dim", t: `\nPrompt: ${details.prompt}` });
					if (details?.prompt && body) spans.push({ s: "dim", t: `\n${"─".repeat(40)}` });
					if (body) spans.push({ s: "toolOutput", t: `\n${body}` });
				} else {
					const lines = body.slice(0, PREVIEW_MAX_CHARS).split("\n").slice(0, PREVIEW_MAX_LINES);
					if (body) spans.push({ s: "toolOutput", t: `\n${lines.join("\n")}` });
					if (body.length > PREVIEW_MAX_CHARS || body.split("\n").length > PREVIEW_MAX_LINES) {
						const key = getKeybindings().keysFor("app.tools.expand")[0] ?? "ctrl+o";
						spans.push({ s: "dim", t: `\n… (${formatKeyHint(key)} to expand)` });
					}
				}

				return jsx("text", { spans });
			},
			async execute(_id, params, signal, onUpdate, ctx) {
				// Guard: circular delegation
				if (ctx.model?.provider === PROVIDER_ID) {
					debug(`askClaude: blocked circular delegation (active provider is ${PROVIDER_ID})`);
					return {
						content: [{ type: "text" as const, text: `Error: ${askClaudeToolName} cannot be used when the active provider is ${PROVIDER_ID}. You're already running through Claude Code.` }],
						details: { error: true },
					};
				}

				const askParams = readAskClaudeParams(params, true);
				const mode = askParams.mode ?? defaultMode;
				if (!allowFull && mode === "full") {
					return {
						content: [{ type: "text" as const, text: `Error: ${askClaudeToolName} full mode is disabled.` }],
						details: { error: true },
					};
				}
				const isolated = askParams.isolated ?? defaultIsolated;
				const toolCalls = new Map<string, ToolCallState>();
				const start = Date.now();

				const progressInterval = setInterval(() => {
					const elapsed = ((Date.now() - start) / 1000).toFixed(0);
					const summary = buildActionSummary(toolCalls, askClaudeToolName);
					const status = summary ? `${elapsed}s — ${summary}` : `${elapsed}s — working...`;
					onUpdate?.({
						content: [{ type: "text", text: status }],
						details: { prompt: askParams.prompt, executionTime: Date.now() - start },
					});
				}, 1000);

				try {
					const result = await promptAndWait(askParams.prompt, mode, toolCalls, signal, {
						systemPrompt: systemPromptText(ctx.getSystemPrompt()),
						appendSkills: askConf?.appendSkills,
						model: askParams.model,
						thinking: askParams.thinking,
						isolated,
						context: isolated ? undefined : buildSessionContext(ctx.sessionManager.getBranch()).messages as Context["messages"],
					});
					clearInterval(progressInterval);
					onUpdate?.({ content: [{ type: "text", text: "" }], details: {} });
					const executionTime = Date.now() - start;
					const actions = buildActionSummary(toolCalls, askClaudeToolName);

					const text = actions
						? `${result.responseText}\n\n[Claude Code actions: ${actions}]`
						: result.responseText;
					return {
						content: [{ type: "text" as const, text }],
						details: { prompt: askParams.prompt, executionTime, actions },
					};
				} catch (err) {
					clearInterval(progressInterval);
					debug(`askClaude error: mode=${mode}, model=${askParams.model ?? "default"}, isolated=${isolated}, elapsed=${((Date.now() - start) / 1000).toFixed(1)}s, error=`, err);
					const msg = errorMessage(err);
					return {
						content: [{ type: "text" as const, text: `Error: ${msg}` }],
						details: { prompt: askParams.prompt, executionTime: Date.now() - start, error: true },
					};
				}
			},
		});
	}
}
