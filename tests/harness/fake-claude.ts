// Fake @anthropic-ai/claude-agent-sdk: `query` and `createSdkMcpServer`.
//
// Each query() call takes the next queued script. A script is an async
// generator that yields SDK messages, like the Claude Code subprocess would.
// The fake adds the `system/init` message before the script and the `result`
// message after it, and stops yielding once the bridge calls close().
//
// The fake also behaves like Claude Code's session persistence: a query that
// resumes a session needs its JSONL file to exist, and every prompt, assistant
// message and tool result is appended to that file. Tests can then compare a
// session's transcript with the history OMP sent.

import { randomUUID } from "crypto";
import { existsSync } from "fs";
import type { UserContentBlock } from "cc-session-io";
import { realIo } from "./session-files.ts";

const { createSession, getSessionPath, openSession } = realIo;

type Message = Record<string, any>;
type ToolHandler = (args: Record<string, unknown>, extra?: unknown) => Promise<any>;

export interface Script {
	(cc: ScriptContext): AsyncGenerator<Message, void, unknown>;
}

export interface McpServer {
	type: "sdk";
	name: string;
	tools: Array<{ name: string; handler: ToolHandler }>;
}

export function createSdkMcpServer({ name, tools }: { name: string; tools: McpServer["tools"] }): McpServer {
	return { type: "sdk", name, tools };
}

const MCP_PREFIX = (server: string) => `mcp__${server}__`;

let nextMessageId = 1;

function streamEvent(event: Message): Message {
	return { type: "stream_event", event, parent_tool_use_id: null, uuid: randomUUID(), session_id: "" };
}

export class ScriptContext {
	constructor(readonly query: FakeQuery) {}

	get options(): Message { return this.query.options; }
	get prompt(): unknown { return this.query.prompt; }

	/** One assistant message with a single text block, streamed and then completed. */
	async *reply(text: string): AsyncGenerator<Message, void, unknown> {
		const id = `msg_${nextMessageId++}`;
		yield streamEvent({ type: "message_start", message: { id, usage: { input_tokens: 10, output_tokens: 0 } } });
		yield streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		yield streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
		yield streamEvent({ type: "content_block_stop", index: 0 });
		yield streamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } });
		yield streamEvent({ type: "message_stop" });
		yield this.query.assistant(id, [{ type: "text", text }], "end_turn");
	}

	/** One assistant message calling an OMP tool through the bridge's MCP server,
	 *  then the MCP call itself. Returns the tool result the bridge delivered. */
	async *useTool(toolUseId: string, toolName: string, input: Record<string, unknown> = {}): AsyncGenerator<Message, any, unknown> {
		const server = this.query.mcpServer();
		const sdkName = `${MCP_PREFIX(server.name)}${toolName}`;
		const id = `msg_${nextMessageId++}`;
		yield streamEvent({ type: "message_start", message: { id, usage: { input_tokens: 10, output_tokens: 0 } } });
		yield streamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolUseId, name: sdkName, input: {} } });
		yield streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
		yield streamEvent({ type: "content_block_stop", index: 0 });
		yield streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } });
		yield streamEvent({ type: "message_stop" });
		yield this.query.assistant(id, [{ type: "tool_use", id: toolUseId, name: sdkName, input }], "tool_use");

		const tool = server.tools.find((t) => t.name === toolName);
		if (!tool) throw new Error(`fake claude: MCP server has no tool ${toolName}`);
		const result = await this.query.untilClosed(tool.handler(input));
		if (result === CLOSED) return undefined;
		this.query.persist((session) => session.addToolResults([{
			toolUseId,
			content: (result.content ?? []).map((b: Message) => b.type === "text" ? b.text : `[${b.type}]`).join("\n"),
			isError: result.isError,
		}]));
		return result;
	}

	/** Resolves once the bridge closes the query. */
	closed(): Promise<void> {
		return this.query.closedPromise;
	}
}

const CLOSED = Symbol("closed");

export class FakeQuery implements AsyncIterable<Message> {
	readonly sessionId: string;
	interruptCalls = 0;
	closeCalls = 0;
	#closed = Promise.withResolvers<void>();
	#isClosed = false;
	#exited: Promise<void> = Promise.resolve();

	constructor(readonly prompt: unknown, readonly options: Message, readonly script: Script | undefined, readonly index: number) {
		this.sessionId = options.resume ?? randomUUID();
	}

	get closedPromise(): Promise<void> { return this.#closed.promise; }
	get isClosed(): boolean { return this.#isClosed; }

	mcpServer(): McpServer {
		const servers = Object.values(this.options.mcpServers ?? {}) as McpServer[];
		if (servers.length !== 1) throw new Error(`fake claude: expected one MCP server, got ${servers.length}`);
		return servers[0];
	}

	assistant(id: string, content: Message[], stopReason: string): Message {
		const message = { id, type: "message", role: "assistant", model: "claude-fake", content, stop_reason: stopReason, stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 5 } };
		this.persist((session) => session.addAssistantMessage(content as any, { stopReason }));
		return { type: "assistant", message, parent_tool_use_id: null, uuid: randomUUID(), session_id: this.sessionId };
	}

	persist(write: (session: ReturnType<typeof openSession>) => void): void {
		if (this.options.persistSession === false || this.#isClosed) return;
		const cwd = this.options.cwd;
		const claudeDir = process.env.CLAUDE_CONFIG_DIR;
		const session = existsSync(getSessionPath(this.sessionId, cwd, claudeDir))
			? openSession({ sessionId: this.sessionId, projectPath: cwd, claudeDir })
			: createSession({ sessionId: this.sessionId, projectPath: cwd, claudeDir });
		write(session);
		session.save();
	}

	untilClosed<T>(promise: Promise<T>): Promise<T | typeof CLOSED> {
		return Promise.race([promise, this.#closed.promise.then(() => CLOSED)]);
	}

	interrupt(): Promise<void> {
		this.interruptCalls++;
		return Promise.resolve();
	}

	close(): void {
		this.closeCalls++;
		this.#isClosed = true;
		this.#closed.resolve();
	}

	/** Like a Claude Code process that takes a while to exit: after close(),
	 *  the bridge's iteration ends only once the returned function is called. */
	holdExit(): () => void {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#exited = promise;
		return resolve;
	}

	async *#run(): AsyncGenerator<Message, void, unknown> {
		const { resume, cwd } = this.options;
		if (resume && !existsSync(getSessionPath(resume, cwd, process.env.CLAUDE_CONFIG_DIR))) {
			throw new Error(`No conversation found with session ID: ${resume}`);
		}
		if (!this.script) throw new Error(`fake claude: no script queued for query #${this.index}`);
		yield { type: "system", subtype: "init", session_id: this.sessionId, uuid: randomUUID() };
		if (typeof this.prompt === "string") {
			const prompt = this.prompt;
			this.persist((session) => session.addUserMessage(prompt));
		} else {
			for await (const input of this.prompt as AsyncIterable<Message>) {
				this.persist((session) => session.addUserMessage(input.message.content as UserContentBlock[]));
			}
		}
		let lastText = "";
		for await (const message of this.script(new ScriptContext(this))) {
			if (message.type === "assistant") {
				lastText = message.message.content.filter((b: Message) => b.type === "text").map((b: Message) => b.text).join("");
			}
			yield message;
		}
		yield { type: "result", subtype: "success", result: lastText, session_id: this.sessionId, uuid: randomUUID(),
			usage: { input_tokens: 10, output_tokens: 5 } };
	}

	[Symbol.asyncIterator](): AsyncIterator<Message> {
		const run = this.#run();
		return {
			next: async () => {
				const next = this.#isClosed ? CLOSED : await this.untilClosed(run.next());
				if (next !== CLOSED) return next;
				await this.#exited;
				return { done: true, value: undefined };
			},
			return: async () => {
				await run.return(undefined);
				return { done: true, value: undefined };
			},
		};
	}
}

export class FakeClaude {
	readonly queries: FakeQuery[] = [];
	#scripts: Script[] = [];
	#waiters: Array<{ count: number; resolve: () => void }> = [];

	/** Queue the script for the next query() call. */
	next(script: Script): void {
		this.#scripts.push(script);
	}

	get pendingScripts(): number { return this.#scripts.length; }

	query = ({ prompt, options }: { prompt: unknown; options?: Message }): FakeQuery => {
		const q = new FakeQuery(prompt, options ?? {}, this.#scripts.shift(), this.queries.length);
		this.queries.push(q);
		for (const waiter of this.#waiters.filter((w) => this.queries.length >= w.count)) waiter.resolve();
		this.#waiters = this.#waiters.filter((w) => this.queries.length < w.count);
		return q;
	};

	/** Resolves once at least `count` queries have started. */
	waitForQueries(count: number): Promise<void> {
		if (this.queries.length >= count) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#waiters.push({ count, resolve });
		return promise;
	}

	reset(): void {
		this.queries.length = 0;
		this.#scripts = [];
		this.#waiters = [];
	}
}
