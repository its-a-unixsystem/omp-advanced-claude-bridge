import { createAssistantMessageEventStream, toolWireSchema, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions, type Tool, type Usage } from "@oh-my-pi/pi-ai";
import { getBundledModelSlice } from "@oh-my-pi/pi-catalog/models";
import { buildSessionContext, formatKeyHint, getKeybindings, type CompactionEntry, type ExtensionAPI, type ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import { compact } from "@oh-my-pi/pi-agent-core/compaction";
import { createSdkMcpServer, query, type EffortLevel, type Options, type Query, type SDKMessage, type SDKResultMessage, type SDKUserMessage, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { Base64ImageSource, ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources";
import { jsx } from "@oh-my-pi/pi-tui";
import { createSession, deleteSession, repairToolPairing } from "cc-session-io";
import { appendFileSync, mkdirSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { PROVIDER_ID, messageContentToText, convertPiMessages } from "./convert.js";
import { buildVariantModels, buildModels, claudeCodeModelId, type ContextWindowMode, type LongContextSettings, resolveModel as _resolveModel } from "./models.js";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX, extractSkillsBlock } from "./skills.js";
import { verifyWrittenSession as _verifyWrittenSession } from "./session-verify.js";
import type { McpResult } from "./extract-tool-results.js";
import { QueryContext } from "./query-state.js";
import { BridgeSession, bridgeSession, bridgeSessions, sharedSession } from "./bridge-session.js";
import { classifyRequest, type RequestKind } from "./request-kind.js";
import { planSync, historyFingerprint, type SyncedHistory } from "./history-sync.js";
import { loadConfig, type Config } from "./config.js";
import { extractAgentsAppend } from "./agents-md.js";
import { jsonSchemaToZodShape } from "./typebox-to-zod.js";
import { buildActionSummary, type ToolCallState } from "./askclaude-ui.js";
import { rateLimitNotice } from "./rate-limit.js";

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

// --- Session persistence ---

// Convert pi messages to Anthropic API format for session import.
// Lossy: non-Anthropic thinking blocks are dropped (no valid signature), and only
// text/image/toolCall block types are handled. If all blocks in an assistant message
// are filtered, the message is dropped — which can create invalid sequences (e.g.
// two user messages in a row, or tool_result without preceding tool_use).
function convertAndImportMessages(
	session: ReturnType<typeof createSession>,
	messages: Context["messages"],
	customToolNameToSdk?: Map<string, string>,
): void {
	const { anthropicMessages, sanitizedIds } = convertPiMessages(messages, customToolNameToSdk);

	debug(`convertAndImportMessages: ${messages.length} pi msgs → ${anthropicMessages.length} anthropic msgs`);
	debug(`convertAndImportMessages: imported roles:`, anthropicMessages.map((m, i) => {
		const c = m.content;
		if (typeof c === "string") return `[${i}]${m.role}:text`;
		if (Array.isArray(c)) return `[${i}]${m.role}:${(c).map((b) => b.type).join("+")}`;
		return `[${i}]${m.role}:?`;
	}).join(" "));
	if (sanitizedIds.size > 0) {
		debug(`convertAndImportMessages: sanitized ${sanitizedIds.size} tool IDs:`,
			[...sanitizedIds.entries()].map(([orig, clean]) => orig === clean ? orig : `${orig}→${clean}`).join(", "));
	}
	// Pre-repair for debug logging; importMessages also repairs internally (idempotent).
	const repaired = repairToolPairing(anthropicMessages);
	if (repaired.length !== anthropicMessages.length) {
		debug(`convertAndImportMessages: repairToolPairing ${anthropicMessages.length} → ${repaired.length} msgs`);
	}
	if (repaired.length) session.importMessages(repaired);
}

// Pi doesn't pass tool results directly — it appends them to the context and calls
// the provider again. classifyRequest extracts them; this logs what it found.
function debugToolResults(context: Context, results: McpResult[]): void {
	debug(`extractAllToolResults: ${results.length} results from ${context.messages.length} msgs`);
	debug(`extractAllToolResults: all msg roles:`, context.messages.map((m, i) => `[${i}]${m.role}`).join(" "));
	for (let r = 0; r < results.length; r++) {
		debug(`extractAllToolResults: result[${r}] id=${results[r].toolCallId}${results[r].isError ? " ERROR" : ""} preview:`, JSON.stringify(results[r].content).slice(0, 150));
	}
}

/** Extract the last user message from context as a prompt string. Returns null if last message is not a user message. */
function extractUserPrompt(messages: Context["messages"]): string | null {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "user") return null;
	if (typeof last.content === "string") return last.content;
	return messageContentToText(last.content) || "";
}

/** Extract the last user message as ContentBlockParam[] (preserving images).
 *  Returns null if no images — caller should fall back to string prompt. */
function extractUserPromptBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "user") return null;
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

async function* wrapPromptStream(blocks: ContentBlockParam[]): AsyncIterable<SDKUserMessage> {
	yield {
		type: "user",
		message: { role: "user", content: blocks } as MessageParam,
		parent_tool_use_id: null,
	};
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
		debug(`compact summary: spawn model=${cliModel} registeredModel=${model.id} promptLen=${promptText.length}`);

		sdkQuery = query({
			prompt: promptText,
			options: {
				cwd,
				env: { ...process.env, DISABLE_AUTO_COMPACT: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
				tools: [],
				strictMcpConfig: true,
				settingSources: [] as SettingSource[],
				skills: [],
				persistSession: false,
				systemPrompt: systemPromptText(context.systemPrompt),
				...(options?.disableReasoning ? { thinking: { type: "disabled" } } : {}),
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

// Two semantic paths, decided by planSync (history-sync.js):
//   REUSE — pi's history before the prompt is the synced prefix, unchanged
//     (same fingerprint), optionally followed by the final assistant message
//     that pi appends after streamSimple returns, which CC's own persisted
//     session already has. Returns the existing sessionId. Keeps CC's prompt
//     cache warm.
//   REBUILD — no session yet, or pi's history has diverged (another provider
//     took a turn, /compact, tree navigation, an edit or pruned tool output no
//     hook reports). Wipes the existing session file (if any) and writes a
//     fresh one containing all prior messages, reusing the same sessionId
//     across rebuilds so UUIDs stay stable for the lifetime of pi's session.
//
// Why a full rebuild rather than patching:
//   Injecting deltas into an existing session creates a branch that CC's
//   --resume doesn't follow (documented attempt prior to this). A complete
//   overwrite at the same path is simpler and correct.
//
// Why reuse the sessionId across rebuilds:
//   CC re-reads the JSONL on every --resume call — no in-process UUID
//   caching. Validated in tests/exp-session-clear.mjs, including the case
//   where CC had appended its own tool_use/tool_result records between
//   rebuilds. Preserving the UUID means stable log correlation across
//   provider switches and no orphaned session files.
//
// Log strings still say "Case 1/2/3/4" so existing diagnostics (int-cache.sh,
// int-session-resume.mjs) keep grepping the same anchors.
//
// Ensures the session has all messages up to (but not including) the last user
// message. Returns the session ID to resume from (null if no resume is needed)
// and the fingerprint of the whole request, which the query reports as synced.
function syncSession(
	session: BridgeSession,
	messages: Context["messages"],
	cwd: string,
	customToolNameToSdk?: Map<string, string>,
	modelId?: string,
): { resumeSessionId: string | null; request: SyncedHistory } {
	const plan = planSync(session.state, messages);

	if (plan.path === "reuse") {
		const state = { ...session.state!, ...plan.priors, reply: undefined, cwd };
		session.state = state;
		debug(`Case 3: ${plan.adoptedReply ? "advanced cursor past trailing assistant, " : ""}resuming session ${state.sessionId.slice(0, 8)}, cursor=${state.cursor}`);
		debug(`syncResult: path=reuse sessionId=${state.sessionId} cursor=${state.cursor}`);
		return { resumeSessionId: state.sessionId, request: plan.request };
	}

	if (plan.path === "clean-start") {
		debug(`Case 1: clean start, ${messages.length} total messages`);
		debug(`syncResult: path=clean-start`);
		return { resumeSessionId: null, request: plan.request };
	}

	const priorMessages = messages.slice(0, -1); // everything before the new user prompt
	const previousSessionId = session.state?.sessionId;
	const previousCursor = session.state?.cursor ?? 0;
	// preserveId: rebuild in place (deleteSession + createSession with the
	// existing UUID), so prompt-cache UUIDs stay stable for log correlation
	// and for any tools that key off them. Skipped only when there's a
	// concurrent writer we shouldn't race — see forceRotate docs.
	const preserveId = previousSessionId !== undefined && !session.state?.forceRotate;
	if (preserveId) {
		// Wipe prior jsonl + companion dir (no-op if nothing to wipe).
		deleteSession(previousSessionId!, cwd, process.env.CLAUDE_CONFIG_DIR);
	}
	const created = createSession({
		projectPath: cwd,
		claudeDir: process.env.CLAUDE_CONFIG_DIR,
		...(preserveId ? { sessionId: previousSessionId } : {}),
		...(modelId ? { model: modelId } : {}),
	});
	convertAndImportMessages(created, priorMessages, customToolNameToSdk);
	created.save();
	verifyWrittenSession(created.jsonlPath, created.sessionId, created.messages.length, cwd);
	session.state = { sessionId: created.sessionId, cwd, ...plan.priors };
	if (previousSessionId === undefined) {
		debug(`Case 2: first turn with ${priorMessages.length} prior messages → session ${created.sessionId.slice(0, 8)}, ${created.messages.length} records`);
	} else if (preserveId) {
		debug(`Case 4: history ${plan.reason} (synced ${previousCursor}, now ${priorMessages.length} total) → rewrote session ${created.sessionId.slice(0, 8)} (same id), ${created.messages.length} records`);
	} else {
		debug(`Case 4 post-abort: ${priorMessages.length} total → new session ${created.sessionId.slice(0, 8)} (was ${previousSessionId.slice(0, 8)}, rotated to avoid race with orphan writer), ${created.messages.length} records`);
	}
	debugSessionPaths(`${created.sessionId.slice(0, 8)}`, cwd, created.jsonlPath);
	debug(`syncResult: path=rebuild sessionId=${created.sessionId} priors=${priorMessages.length} ${previousSessionId === undefined ? "first" : preserveId ? "preserved" : "rotated-post-abort"}`);
	return { resumeSessionId: created.sessionId, request: plan.request };
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

// --- Effort level mapping ---
// OMP reasoning levels → CC SDK effort levels

const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max", max: "max",
};

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
	if (c.turnSawStreamEvent) return;
	const assistantMsg = (message as any).message;
	if (!assistantMsg?.content) return;
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

/** Background consumer: iterates the SDK generator, pushing events to currentPiStream.
 *  Runs until the query ends. Per turn, the SDK yields stream_events (deltas), then
 *  an assistant message (completed blocks). On tool_use, the stream is ended by
 *  whichever path handles it first (processStreamEvent or processAssistantMessage),
 *  and the MCP handler blocks the generator until pi delivers the tool result.
 *  With `endOnToolUse`, no tool result can come, so the tool-use turn is the last. */
async function consumeQuery(
	sdkQuery: ReturnType<typeof query>,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	queryCtx: QueryContext,
	endOnToolUse: boolean,
): Promise<void> {
	for await (const message of sdkQuery) {
		if (queryCtx.aborted) break;
		if (message.type === "result" && (message.subtype !== "success" || message.is_error)) {
			throw new Error(resultErrorText(message));
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
				if (!queryCtx.turnSawStreamEvent && message.subtype === "success") {
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
				if ((message as any).subtype === "init" && (message as any).session_id) {
					queryCtx.claudeSessionId = (message as any).session_id;
				}
				break;
			case "user":
				break; // SDK echo of user prompt — not needed
			case "rate_limit_event": {
				const info = (message as any).rate_limit_info;
				debug("consumeQuery: rate_limit_event", JSON.stringify(info).slice(0, 300));
				const notice = rateLimitNotice(info);
				if (notice) piUI?.notify(notice.message, notice.level);
				break;
			}
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
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const owner = bridgeSession(options?.sessionId, options?.providerSessionState);
	const request = classifyRequest(context.messages, owner);
	const lastMsgRole = context.messages[context.messages.length - 1]?.role;
	debug(`provider: streamClaudeAgentSdk called, session=${owner?.id ?? "none"}, kind=${request.kind}, lastMsgRole=${lastMsgRole}, liveQueries=${owner?.queries.size ?? 0}`);

	switch (request.kind) {
		case "tool-results":
			deliverToolResults(stream, model, context, request);
			break;
		case "orphaned-result":
			finishOrphanedToolResult(stream, model);
			break;
		case "turn":
		case "helper":
			startProviderQuery(stream, model, context, owner, excludeToolName, options);
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
): void {
	debugToolResults(context, results);
	claimCurrentPiStream(stream, "tool-result", resultCtx);
	resultCtx.resetTurnState(model);
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
		const userPrompt = extractUserPrompt(context.messages);
		if (userPrompt) {
			resultCtx.deferredUserMessages.push(userPrompt);
			debug(`provider: deferred user message for replay after query: ${userPrompt.slice(0, 60)}`);
		}
	}

	resultCtx.synced = historyFingerprint(context.messages);
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
): void {
	const helper = owner === null;
	const queryCtx = new QueryContext();
	debug(`provider: fresh query setup, helper=${helper}, session=${owner?.id ?? "none"}, liveQueries=${owner?.queries.size ?? 0}`);
	claimCurrentPiStream(stream, "fresh-query", queryCtx);
	queryCtx.resetTurnState(model);

	const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context, excludeToolName);
	const cwd = options?.cwd ?? process.cwd();
	let resumeSessionId: string | null = null;
	if (!owner) {
		debug(`Case 1 synthetic: clean start for a request without providerSessionState, sessionId=${options?.sessionId ?? "none"}`);
		debug(`syncResult: path=clean-start helper`);
	} else {
		const synced = syncSession(owner, context.messages, cwd, customToolNameToSdk, model.id);
		resumeSessionId = synced.resumeSessionId;
		queryCtx.synced = synced.request;
	}
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
			session: owner?.state ? { sessionId: owner.state.sessionId.slice(0, 8), cursor: owner.state.cursor } : null,
			messageRoles: context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
		});
		// Recover: use a continuation prompt so the SDK doesn't send an empty text block
		promptText = "[continue]";
	}

	const prompt: string | AsyncIterable<SDKUserMessage> = promptBlocks
		? wrapPromptStream(promptBlocks)
		: promptText;
	const mcpServers = buildMcpServers(mcpTools, queryCtx);
	const { queryOptions, cliModel, effort, appendSystemPrompt, strictMcpConfigEnabled } =
		buildProviderQueryOptions(model, context.systemPrompt, options, cwd, mcpServers, resumeSessionId);
	debug("provider: fresh query",
		`model=${cliModel} msgs=${context.messages.length} tools=${mcpTools.length}`,
		`resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${effort ?? "default"}`,
		`appendSys=${appendSystemPrompt} strictMcp=${strictMcpConfigEnabled}`,
		`prompt=${promptText.slice(0, 60)}${promptBlocks ? " [+images]" : ""}`);

	const sdkQuery = query({ prompt, options: queryOptions });
	queryCtx.claudeSessionId = resumeSessionId ?? undefined;
	runProviderQuery(sdkQuery, queryCtx, owner, model, customToolNameToPi, queryOptions, options?.signal);
}

type ProviderQueryOptions = Options & { cwd: string; extraArgs: Record<string, string | null> };

function buildProviderQueryOptions(
	model: Model<any>,
	systemPrompt: Context["systemPrompt"],
	options: SimpleStreamOptions | undefined,
	cwd: string,
	mcpServers: Options["mcpServers"],
	resumeSessionId: string | null,
) {
	const appendSystemPrompt = providerSettings.appendSystemPrompt !== false;
	const agentsAppend = appendSystemPrompt ? extractAgentsAppend(cwd) : undefined;
	const skillsAppend = appendSystemPrompt ? extractSkillsBlock(systemPromptText(systemPrompt)) : undefined;
	const appendParts = [agentsAppend, skillsAppend].filter((part): part is string => Boolean(part));
	const systemPromptAppend = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;

	// MCP auto-loading suppression: CC reads MCP servers from ~/.claude.json (top-level
	// + per-project) and .mcp.json. Since pi executes tools (not CC), those are pure
	// token overhead. --strict-mcp-config tells the binary to use ONLY mcpServers passed
	// programmatically and ignore filesystem MCP entries — applied unconditionally because
	// settingSources=undefined does NOT give isolation (the CC default loads all sources).
	const settingSources: SettingSource[] | undefined = appendSystemPrompt
		? undefined
		: providerSettings.settingSources ?? ["user", "project"];
	const strictMcpConfigEnabled = providerSettings.strictMcpConfig !== false;
	const claudeExecutable = providerSettings.pathToClaudeCodeExecutable;

	const reasoning = options?.disableReasoning ? undefined : options?.reasoning;
	const mappedEffort = reasoning && model.thinking?.effortMap?.[reasoning];
	const effort = mappedEffort === "xhigh"
		? mappedEffort
		: reasoning && (REASONING_TO_EFFORT[mappedEffort ?? reasoning] ?? REASONING_TO_EFFORT[reasoning]);

	// cliModel is the actual id sent to Claude Code (may carry [1m]); model.id is the
	// pi-registered id. Log cliModel so debug lines reflect what CC actually received.
	const cliModel = claudeCodeModelId(model, longContextSettings);
	const extraArgs: Record<string, string | null> = { model: cliModel };
	if (strictMcpConfigEnabled) extraArgs["strict-mcp-config"] = null;
	// Opus 4.7 defaults thinking.display to "omitted" (empty thinking text in stream).
	// Force summarized so thinking_delta events arrive. See anthropics/claude-agent-sdk-python#830.
	if (effort) extraArgs["thinking-display"] = "summarized";

	// Suppress claude.ai cloud MCP servers (Figma/Canva/etc. auto-discovered via OAuth
	// when the user is logged into Anthropic). These are a separate code path from
	// filesystem MCP and are NOT blocked by --strict-mcp-config or settingSources=undefined.
	// The native CC binary gates them on env var ENABLE_CLAUDEAI_MCP_SERVERS: setting it
	// to "0"/"false"/"no"/"off" makes the loader return early before any cloud fetch.
	// DISABLE_AUTO_COMPACT=1: pi owns context-management and propagates its own
	// /compact (the next turn's sync sees the compacted history). Letting CC
	// also autocompact would double-flush the prompt cache and races pi's
	// threshold with CC's, including CC's anti-thrashing guard (issue #8).
	// Manual /compact in CC still works (we never invoke it).
	const childEnv = { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1" };
	const queryOptions: ProviderQueryOptions = {
		cwd,
		env: childEnv,
		tools: [],
		permissionMode: "bypassPermissions",
		includePartialMessages: true,
		systemPrompt: {
			type: "preset", preset: "claude_code",
			append: systemPromptAppend ? systemPromptAppend : undefined,
		},
		extraArgs,
		...(options?.disableReasoning ? { thinking: { type: "disabled" } } : effort ? { effort } : {}),
		...(settingSources ? { settingSources } : {}),
		...(mcpServers ? { mcpServers } : {}),
		...(resumeSessionId ? { resume: resumeSessionId } : {}),
		...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
		...makeCliDebugOptions("provider"),
	};

	return { queryOptions, cliModel, effort, appendSystemPrompt, strictMcpConfigEnabled };
}

function runProviderQuery(
	sdkQuery: Query,
	queryCtx: QueryContext,
	owner: BridgeSession | null,
	model: Model<any>,
	customToolNameToPi: Map<string, string>,
	queryOptions: ProviderQueryOptions,
	signal?: AbortSignal,
): void {
	const { cwd } = queryOptions;
	const helper = owner === null;
	// The query abort targets: sdkQuery, or the continuation replaying a steer.
	let runningQuery = sdkQuery;
	owner?.queries.add(queryCtx);

	// Every query ends here, once: aborted (its request's signal, or its session
	// closing), failed, or done after replaying its deferred steers. The end
	// takes the query out of its session and decides the sync state it leaves
	// behind before the stream's terminal event lets OMP send its next request.
	// An abort ends the query right away, while Claude Code may still be
	// exiting, so a tool result or prompt that arrives meanwhile finds no query
	// to join and a new turn sees the rotated session.
	let ended = false;
	const forwardAbort = () => queryCtx.abort();
	const endQuery = (end: "done" | "aborted" | "error", error?: unknown) => {
		if (ended) return;
		ended = true;
		signal?.removeEventListener("abort", forwardAbort);
		queryCtx.deferredUserMessages = [];
		owner?.endQuery(queryCtx, end === "done"
			? { kind: "done", sessionId: queryCtx.claudeSessionId, cwd, synced: queryCtx.synced, reply: queryCtx.turnOutput?.timestamp }
			: { kind: end });
		queryCtx.drainToolCalls(end === "aborted" ? "Operation aborted" : "Query ended");
		debug(`provider: query ended, end=${end}, helper=${helper}, session=${queryCtx.claudeSessionId?.slice(0, 8) ?? "none"}, stopReason=${queryCtx.turnOutput?.stopReason}${error === undefined ? "" : `, error=${errorMessage(error)}`}`);
		if (owner?.closed) debug(`provider: session ${owner.id} closed, sync state dropped`);
		else if (owner?.state && end === "done") debug(`provider: synced session=${owner.state.sessionId.slice(0, 8)}, cursor=${owner.state.cursor}`);
		else if (owner?.state && end === "aborted") debug(`provider: abort marked session ${owner.state.sessionId.slice(0, 8)} needsRebuild + forceRotate`);

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
		(continuation) => { runningQuery = continuation; })
		.then(() => endQuery("done"), (error) => endQuery("error", error))
		.finally(() => {
			// Final SDK cleanup waits for iteration to end, even when an
			// abort already closed the running query to make it stop.
			sdkQuery.close();
			if (helper && queryCtx.claudeSessionId) {
				deleteSession(queryCtx.claudeSessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
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
): Promise<void> {
	await consumeQuery(sdkQuery, customToolNameToPi, model, queryCtx, endOnToolUse);
	while (queryCtx.deferredUserMessages.length > 0 && !queryCtx.aborted) {
		const steerPrompt = queryCtx.deferredUserMessages.shift()!;
		const resumeId = queryCtx.claudeSessionId;
		if (!resumeId) {
			debug(`WARNING: no session to resume for deferred message, dropping`);
			break;
		}
		debug(`provider: replaying deferred user message: ${steerPrompt.slice(0, 60)}`);
		queryCtx.resetTurnState(model);
		const contOptions = { ...queryOptions, resume: resumeId, ...makeCliDebugOptions("continuation") };
		const contQuery = query({ prompt: steerPrompt, options: contOptions });
		setRunningQuery(contQuery);
		debug(`provider: continuation query, model=${queryOptions.extraArgs.model}, resume=${resumeId.slice(0, 8)}, prompt=${steerPrompt.slice(0, 60)}`);
		try {
			await consumeQuery(contQuery, customToolNameToPi, model, queryCtx, false);
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
		sessionId?: string;
	},
): Promise<{ responseText: string; stopReason: string }> {
	if (signal?.aborted) throw new Error("Aborted");

	const cwd = process.cwd();
	const requestedModel = options?.model ?? "opus";
	const model = resolveModel(requestedModel);
	const modelId = model?.id ?? requestedModel;
	const cliModel = model ? claudeCodeModelId(model, longContextSettings) : modelId;

	// Session resume for shared mode — sync pi's context into the agent's
	// bridge session. AskClaude only runs while another provider is active, so
	// any provider state is behind pi's history; syncSession reuses it only
	// when the context starts with the synced history and rebuilds it otherwise.
	// The tool context only knows the session-file id, which differs from the
	// provider sessionId after a fresh session; a miss imports the same history
	// into its own session.
	// Note: doesn't update the sync state after completion, so the next
	// provider call sees a diverged history and triggers a Case 4 rebuild.
	let resumeSessionId: string | null = null;
	if (!options?.isolated && options?.context?.length) {
		const contextWithPrompt = [...options.context, { role: "user" as const, content: prompt, timestamp: Date.now() }];
		const session = sharedSession(options.sessionId);
		resumeSessionId = syncSession(session, contextWithPrompt as Context["messages"], cwd, undefined, modelId).resumeSessionId;
	}

	// Mode → disallowed tools
	const disallowedTools = MODE_DISALLOWED_TOOLS[mode] ?? [];

	// Skills append
	const skillsBlock = options?.appendSkills !== false && options?.systemPrompt
		? extractSkillsBlock(options.systemPrompt) : undefined;

	// Effort
	const effort = options?.thinking && options.thinking !== "off"
		? REASONING_TO_EFFORT[options.thinking] : undefined;

	const claudeExecutable = providerSettings.pathToClaudeCodeExecutable;

	const extraArgs: Record<string, string | null> = {
		"strict-mcp-config": null,
		model: cliModel,
	};
	if (effort) extraArgs["thinking-display"] = "summarized";

	debug("askClaude:",
		`mode=${mode} model=${modelId} cliModel=${cliModel} effort=${effort ?? "default"}`,
		`isolated=${options?.isolated ?? false} resume=${resumeSessionId?.slice(0, 8) ?? "none"}`,
		`skills=${Boolean(skillsBlock)} promptLen=${prompt.length}`);

	const sdkQuery = query({
		prompt,
		options: {
			cwd,
			env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1" },
			permissionMode: "bypassPermissions",
			...(disallowedTools.length ? { disallowedTools } : {}),
			...(effort ? { effort } : {}),
			systemPrompt: skillsBlock
				? { type: "preset", preset: "claude_code", append: skillsBlock }
				: undefined,
			settingSources: ["user", "project"] as SettingSource[],
			extraArgs,
			...(resumeSessionId ? { resume: resumeSessionId } : {}),
			...(options?.isolated ? { persistSession: false } : {}),
			...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
			...makeCliDebugOptions("askclaude"),
		},
	});

	// Abort handling
	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		sdkQuery.interrupt().catch(() => { try { sdkQuery.close(); } catch {} });
	};

	let responseText = "";
	let sdkMessageCount = 0;
	let resultSubtype: string | undefined;

	try {
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
		sdkQuery.close();
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

	// OMP closes BridgeSession entries itself on new, switched, fresh and
	// disposed sessions. Main shutdown (including /reload) drops the entries
	// that only AskClaude created and no provider map owns. It leaves the others
	// to OMP: dispose emits session_shutdown before it aborts the agent's turn,
	// and closing would abort the turn's query first, without the reason OMP
	// records for an interrupted turn (which `omp --restore` looks for).
	pi.on("session_start", (_event, ctx) => {
		if (ctx.agent.kind === "main") piUI = ctx.ui;
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		piUI = null;
		const unowned = [...bridgeSessions.values()].filter((session) => !session.states);
		debug(`session_shutdown: closing ${unowned.length} of ${bridgeSessions.size} bridge session(s)`);
		for (const session of unowned) session.close();
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

	// pi /compact, branching and session-tree navigation (rewind /
	// fork-at-point / branch switch) rewrite pi's history without telling the
	// provider which session they belong to. No hook is needed: the next turn's
	// syncSession compares that session's synced prefix with the history it
	// sends and rebuilds when they differ.

	// OMP rebinds this factory for child sessions. They share the session
	// registry, but each registration gets its own configured tool name.
	const askConf = config.askClaude;
	const askClaudeToolName = askConf?.name ?? "AskClaudeAdvanced";
	pi.registerProvider(PROVIDER_ID, {
		baseUrl: `https://${PROVIDER_ID}.invalid`,
		apiKey: "not-used",
		api: PROVIDER_ID,
		models: registeredModels,
		streamSimple: (model, context, options) => streamClaudeAgentSdk(model, context, askClaudeToolName, options),
	});

	// --- AskClaude tool ---

	const allowFull = askConf?.allowFullMode !== false;
	const defaultMode = allowFull ? askConf?.defaultMode ?? "read" : "read";
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

	let modeDesc = `"read" (default): questions about the codebase — review, analysis, explain. "none": general knowledge only (no file access).`;
	if (allowFull) modeDesc += ` "full": allows writing and bash execution (careful: runs without feedback to pi).`;

	if (askConf?.enabled !== false) {
		const z = pi.zod;
		const askClaudeParams = z.object({
			prompt: z.string().describe("The question or task for Claude Code. By default Claude sees the full conversation history. Don't research up front, let Claude explore."),
			mode: z.enum(modeValues).describe(modeDesc).optional(),
			model: z.string().describe('Claude model (e.g. "opus", "sonnet", "haiku", or full ID). Defaults to "opus".').optional(),
			thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).describe("Thinking effort level. Omit to use Claude Code's default.").optional(),
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
						sessionId: ctx.sessionManager.getSessionId(),
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
