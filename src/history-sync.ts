import { createHash } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Context, Message } from "@oh-my-pi/pi-ai";
import {
	createSession, getClaudeDir, getSessionPath, normalizeProjectPath, repairWithOrigin,
	serializeJsonl, Session, type AssistantRecord, type JsonlRecord, type ToolResultBlock, type UserContentBlock, type UserRecord,
} from "cc-session-io";
import { convertPiMessages, isPromptRole } from "./convert.js";

export interface SessionState {
	sessionId: string;
	cwd: string;
	claudeDir: string;
	promptDigest: string;
	digests: string[];
	uuids: (string | null)[];
	cuttable: boolean[];
	// The rolling JSONL fingerprint at each cuttable UUID, including attachments.
	cutDigests: (string | null)[];
	stamp: { size: number; mtimeMs: number; ctimeMs: number; digest: string } | null;
	tailUuid: string | null;
	// An interrupted or unmatched turn may only be forked, never resumed as-is.
	dirty: boolean;
}

// In-process, distinguish the bridge's last reply from an equivalent regenerated
// one; saved recordings are replayable by content without this live proof.
const replies = new WeakMap<SessionState, { index: number; timestamp: number }>();

type TranscriptRecord = JsonlRecord & { uuid: string; parentUuid: string | null };

const EMPTY_DIGEST = "0".repeat(64);
const READ_CHUNK_SIZE = 64 * 1024;

// Chaining complete lines lets a newly appended turn extend the disk proof
// without re-reading the transcript or serializing a hash implementation's state.
function extendDigest(previous: string, line: Buffer): string {
	return createHash("sha256").update(previous).update(line).digest("hex");
}

function digestMessage(message: Message): string {
	const { role, content } = message;
	const fields = role === "assistant" ? [role, content, message.provider, message.api, message.stopReason]
		: role === "toolResult" ? [role, content, message.toolCallId, message.toolName, message.isError]
		: [role, content];
	return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

function commonPrefix(digests: readonly string[], priors: Context["messages"], recorded: SessionState): number {
	const reply = replies.get(recorded);
	let count = 0;
	while (count < digests.length && digests[count] === recorded.digests[count]) {
		if (reply?.index === count && priors[count].timestamp !== reply.timestamp) break;
		count++;
	}
	return count;
}

function trackTools(message: Message, pending: Set<string>) {
	if (message.role === "toolResult") pending.delete(message.toolCallId);
	else {
		pending.clear();
		if (message.role === "assistant") {
			for (const block of message.content) if (block.type === "toolCall") pending.add(block.id);
		}
	}
}

function isAssistant(record: TranscriptRecord): record is AssistantRecord {
	return record.type === "assistant";
}

function isUser(record: TranscriptRecord): record is UserRecord {
	return record.type === "user";
}

function isWritable(record: TranscriptRecord) {
	return isAssistant(record) || isUser(record) || record.type === "attachment";
}

function transcriptChain(records: readonly JsonlRecord[], sessionId: string, root: string | null, cut?: string) {
	const byId = new Map<string, TranscriptRecord>();
	const parents = new Set<string>();
	for (const record of records) {
		if (!("uuid" in record && typeof record.uuid === "string" && "parentUuid" in record
			&& (typeof record.parentUuid === "string" || record.parentUuid === null)
			&& record.sessionId === sessionId && !record.isSidechain)) continue;
		if (byId.has(record.uuid) || record.uuid === root) return null;
		const linked = record as TranscriptRecord;
		byId.set(linked.uuid, linked);
		if (linked.parentUuid !== null && (isWritable(linked) || linked.type === "system")) parents.add(linked.parentUuid);
	}
	let tip = cut ?? root;
	if (!cut) {
		// Claude Code can resume from a system record as well as message/attachment leaves.
		let latest = -Infinity;
		for (const record of byId.values()) {
			if (parents.has(record.uuid) || !(isWritable(record) || record.type === "system")
				|| typeof record.timestamp !== "string") continue;
			const time = Date.parse(record.timestamp);
			if (time > latest) {
				latest = time;
				tip = record.uuid;
			}
		}
		if (tip === root && byId.size) return null;
	}
	const chain: TranscriptRecord[] = [];
	while (tip !== root) {
		const record: TranscriptRecord | undefined = tip === null ? undefined : byId.get(tip);
		if (!record) return null;
		chain.push(record);
		byId.delete(record.uuid);
		tip = record.parentUuid;
	}
	return chain.reverse();
}

function transcriptPath(state: SessionState) {
	return getSessionPath(state.sessionId, state.cwd, state.claudeDir);
}

function fileStamp(path: string) {
	try {
		const { size, mtimeMs, ctimeMs } = statSync(path);
		return { size, mtimeMs, ctimeMs };
	} catch {
		return null;
	}
}

function* readLines(fd: number, offset: number, limit: number): IterableIterator<Buffer> {
	const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_SIZE, limit - offset));
	let parts: Buffer[] = [];
	while (offset < limit) {
		const count = readSync(fd, buffer, 0, Math.min(buffer.length, limit - offset), offset);
		if (!count) throw new Error("Claude Code transcript ended mid-read");
		offset += count;
		const chunk = buffer.subarray(0, count);
		let start = 0;
		for (let end: number; (end = chunk.indexOf(10, start)) !== -1; start = end + 1) {
			const line = chunk.subarray(start, end + 1);
			if (!parts.length) yield line;
			else {
				parts.push(line);
				yield Buffer.concat(parts);
				parts = [];
			}
		}
		// The read buffer will be reused; only a line spanning chunks needs a copy.
		if (start < count) parts.push(Buffer.from(chunk.subarray(start)));
	}
	if (parts.length) throw new Error("Incomplete Claude Code transcript line");
}

// Read appended bytes for a live turn, or stop at the cut UUID within the
// recorded byte range for a fork. Fingerprint the raw bytes before parsing.
function readRecords(path: string, offset = 0, digest = EMPTY_DIGEST, cut?: { uuid: string; size: number }) {
	const fd = openSync(path, "r");
	try {
		const { size, mtimeMs, ctimeMs } = fstatSync(fd);
		const limit = cut ? Math.min(size, cut.size) : size;
		if (limit < offset) throw new Error("Claude Code transcript was truncated");
		const records: JsonlRecord[] = [];
		const proofs = new Map<string, string>();
		for (const line of readLines(fd, offset, limit)) {
			digest = extendDigest(digest, line);
			const text = line.toString("utf8", 0, line.length - 1);
			if (!text.trim()) continue;
			const record = JSON.parse(text) as JsonlRecord;
			records.push(record);
			if (cut) {
				if (record.uuid === cut.uuid) break;
			} else if (typeof record.uuid === "string") proofs.set(record.uuid, digest);
		}
		return { records, proofs, stamp: { size, mtimeMs, ctimeMs, digest } };
	} finally {
		closeSync(fd);
	}
}

function forkPrefix(source: SessionState, cutIndex: number): TranscriptRecord[] | null {
	const uuid = source.uuids[cutIndex];
	const expected = source.cutDigests[cutIndex];
	if (!source.stamp || !uuid || !expected) return null;
	try {
		const { records, stamp } = readRecords(transcriptPath(source), 0, EMPTY_DIGEST, { uuid, size: source.stamp.size });
		if (stamp.digest !== expected) return null;
		const chain = transcriptChain(records, source.sessionId, null, uuid);
		const tip = chain?.at(-1);
		if (tip && isWritable(tip)) return chain;
	} catch {
		// OMP's messages are authoritative if the native prefix is unreadable.
	}
	return null;
}

function importSuffix(target: Session, messages: Context["messages"], state: SessionState, names?: Map<string, string>) {
	const converted = convertPiMessages(messages, names);
	const repaired = repairWithOrigin(converted.anthropicMessages);
	const uuids = new Array<string | null>(messages.length).fill(null);
	const lastInRecord = new Set<number>();
	for (const [i, message] of repaired.messages.entries()) {
		let results: ToolResultBlock[] = [];
		const source = repaired.origin[i];
		// The leading orphan-result placeholder is only needed on an empty transcript.
		if (i === 0 && source === null && state.tailUuid) continue;
		let uuid: string;
		let resultUuid: string | undefined;
		if (message.role === "assistant") {
			uuid = target.addAssistantMessage(typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content);
		} else if (typeof message.content === "string") {
			uuid = target.addUserMessage(message.content);
		} else {
			const rest: Exclude<UserContentBlock, ToolResultBlock>[] = [];
			for (const block of message.content) {
				if (block.type === "tool_result") results.push(block);
				else if (block.type === "text" || block.type === "image") rest.push(block);
			}
			// A repair can add missing results to an ordinary prompt. Claude Code
			// writes the tool results and user content as separate records.
			resultUuid = results.length ? target.addUserMessage(results) : undefined;
			if (!rest.length && !resultUuid) continue;
			uuid = rest.length ? target.addUserMessage(rest) : resultUuid!;
		}
		state.tailUuid = uuid;
		if (source === null) continue;
		const origins = converted.origins[source];
		const originalContent = converted.anthropicMessages[source].content;
		const retained = results.length ? new Set(results) : undefined;
		let lastResult: number | undefined;
		let lastUser: number | undefined;
		for (const [blockIndex, index] of origins.entries()) {
			// Repair keeps the original result block object if it survived. Match
			// by identity, not ID (which a synthesized result can share).
			if (messages[index].role === "toolResult") {
				if (!(Array.isArray(originalContent) && retained?.has(originalContent[blockIndex] as ToolResultBlock))) continue;
				uuids[index] = resultUuid!;
				lastResult = index;
			} else {
				uuids[index] = uuid;
				lastUser = index;
			}
		}
		if (lastResult !== undefined) lastInRecord.add(lastResult);
		if (lastUser !== undefined) lastInRecord.add(lastUser);
	}
	const pending = new Set<string>();
	for (const [i, message] of messages.entries()) {
		if (!(message.role === "developer" && uuids[i] === null)) trackTools(message, pending);
		state.uuids.push(uuids[i]);
		state.cuttable.push(uuids[i] !== null && lastInRecord.has(i) && pending.size === 0);
	}
}

function writeTranscript(target: Session, keptRecords: number, state: SessionState, onWrite?: (path: string, id: string, records: number, cwd: string) => void) {
	const records = target.records;
	if (!records.length) return;
	// Same timestamp floor as Session.importMessages: leave native records
	// untouched, but don't make a long synthetic suffix newer than the next turn.
	let floor = -Infinity;
	for (let i = 0; i < keptRecords; i++) {
		const time = Date.parse(records[i].timestamp as string);
		if (time > floor) floor = time;
	}
	let time = Math.max(floor + 1, Date.now() - (records.length - keptRecords) + 1);
	for (let i = keptRecords; i < records.length; i++) records[i].timestamp = new Date(time++).toISOString();
	mkdirSync(dirname(target.jsonlPath), { recursive: true });
	const bytes = Buffer.from(serializeJsonl(records as JsonlRecord[]), "utf8");
	writeFileSync(target.jsonlPath, bytes, { flag: "wx", mode: 0o600 });

	// Match the serializer's single line per record without parsing the data
	// we just wrote. A fork changes session IDs, so its cut proofs are new.
	const proofs = new Map<string, string>();
	let digest = EMPTY_DIGEST;
	let start = 0;
	for (const record of records) {
		const end = bytes.indexOf(10, start) + 1;
		digest = extendDigest(digest, bytes.subarray(start, end));
		if (typeof record.uuid === "string") proofs.set(record.uuid, digest);
		start = end;
	}
	for (let i = 0; i < state.uuids.length; i++) {
		if (state.cuttable[i]) state.cutDigests[i] = proofs.get(state.uuids[i]!)!;
	}
	const stamp = fileStamp(target.jsonlPath);
	if (stamp?.size === bytes.length) state.stamp = { ...stamp, digest };
	onWrite?.(target.jsonlPath, state.sessionId, records.length, state.cwd);
}

/** Reuse only the exact recorded transcript. Divergence always writes to a new UUID. */
export function syncHistory(
	previous: SessionState | null, priors: Context["messages"], cwd: string, promptDigest: string,
	names?: Map<string, string>, model?: string, onWrite?: (path: string, id: string, records: number, cwd: string) => void,
): SessionState {
	cwd = normalizeProjectPath(cwd);
	const claudeDir = getClaudeDir();
	const digests = priors.map(digestMessage);
	const source = previous?.cwd === cwd && previous.claudeDir === claudeDir && previous.promptDigest === promptDigest ? previous : null;
	let kept = source ? commonPrefix(digests, priors, source) : 0;
	if (source && !source.dirty && source.stamp && source.tailUuid && kept === digests.length && kept === source.digests.length) {
		const current = fileStamp(transcriptPath(source));
		if (current?.size === source.stamp.size && current.mtimeMs === source.stamp.mtimeMs
			&& current.ctimeMs === source.stamp.ctimeMs) return source;
	}

	const fresh = createSession({ projectPath: cwd, claudeDir, model });
	let target = fresh;
	let keptRecords = 0;
	if (source) {
		while (kept > 0 && !source.cuttable[kept - 1]) kept--;
		const prefix = kept ? forkPrefix(source, kept - 1) : null;
		if (prefix) {
			for (const record of prefix) record.sessionId = fresh.sessionId;
			keptRecords = prefix.length;
			target = new Session({
				sessionId: fresh.sessionId, projectPath: fresh.projectPath, cwd, jsonlPath: fresh.jsonlPath, model, records: prefix,
			});
		} else kept = 0;
	}
	const state: SessionState = {
		sessionId: fresh.sessionId, cwd, claudeDir, promptDigest, digests,
		uuids: source?.uuids.slice(0, kept) ?? [], cuttable: source?.cuttable.slice(0, kept) ?? [],
		cutDigests: new Array(digests.length).fill(null),
		stamp: null, tailUuid: kept ? source!.uuids[kept - 1] : null, dirty: false,
	};
	importSuffix(target, kept ? priors.slice(kept) : priors, state, names);
	writeTranscript(target, keptRecords, state, onWrite);
	return state;
}

function assistantMatches(records: AssistantRecord[], assistant: Extract<Message, { role: "assistant" }>) {
	if (assistant.stopReason === "error" || assistant.stopReason === "aborted") return false;
	const ids: string[] = [];
	let text = "";
	for (const record of records) {
		for (const block of record.message.content) {
			if (block.type === "text") text += block.text;
			else if (block.type === "tool_use") ids.push(block.id);
		}
	}
	let next = 0;
	let expected = "";
	for (const block of assistant.content) {
		if (block.type === "text") expected += block.text;
		else if (block.type === "toolCall" && ids[next++] !== block.id) return false;
	}
	return text === expected && next === ids.length;
}

/** Align the committed OMP turn with native records, stopping at the first unproven slot. */
export function recordTurn(base: SessionState, promptUuid: string, messages: Context["messages"], clean: boolean): SessionState {
	const state = {
		...base, digests: [...base.digests], uuids: [...base.uuids], cuttable: [...base.cuttable], cutDigests: [...base.cutDigests], dirty: true,
	};
	const previousReply = replies.get(base);
	if (previousReply) replies.set(state, previousReply);
	try {
		const tail = readRecords(transcriptPath(base), base.stamp?.size, base.stamp?.digest);
		const chain = transcriptChain(tail.records, base.sessionId, base.tailUuid);
		if (!chain) return state;
		state.stamp = tail.stamp;
		state.tailUuid = chain.at(-1)?.uuid ?? base.tailUuid;
		const visible = chain.flatMap((record, index) => isAssistant(record) || isUser(record) && (!record.isMeta || record.uuid === promptUuid)
			? [{ record, index }] : []);
		const pending = new Set<string>();
		let next = 0;
		let mapped = 0;
		const append = (message: Message, end: number, allowCut = true) => {
			trackTools(message, pending);
			// Keep native attachments and meta-user records, but end at a
			// record the session writer can chain new messages onto.
			while (end + 1 < chain.length) {
				const following = chain[end + 1];
				if (following.type !== "attachment" && !(isUser(following) && following.isMeta)) break;
				end++;
			}
			state.digests.push(digestMessage(message));
			const uuid = chain[end].uuid;
			const cuttable = allowCut && pending.size === 0;
			state.uuids.push(uuid);
			state.cuttable.push(cuttable);
			state.cutDigests.push(cuttable ? tail.proofs.get(uuid)! : null);
			mapped++;
		};
		align: while (mapped < messages.length && next < visible.length) {
			const message = messages[mapped];
			const start = visible[next];
			if (mapped === 0) {
				if (!isPromptRole(message.role) || !isUser(start.record) || start.record.uuid !== promptUuid) break;
				append(message, start.index);
				next++;
			} else if (message.role === "assistant" && isAssistant(start.record)) {
				const records = [start.record];
				let end = next + 1;
				while (end < visible.length) {
					const item = visible[end].record;
					if (!isAssistant(item) || item.message.id !== start.record.message.id) break;
					records.push(item);
					end++;
				}
				if (!assistantMatches(records, message)) break;
				append(message, visible[end - 1].index);
				next = end;
			} else if (message.role === "toolResult" && isUser(start.record)) {
				const ids = new Set<string>();
				let end = next;
				for (; end < visible.length; end++) {
					const item = visible[end].record;
					if (!isUser(item) || !Array.isArray(item.message.content)
						|| !item.message.content.length || !item.message.content.every(block => block.type === "tool_result")) break;
					for (const block of item.message.content) {
						if (ids.has(block.tool_use_id)) break align;
						ids.add(block.tool_use_id);
					}
				}
				if (!ids.size) break;
				let last = mapped;
				while (last < messages.length) {
					const result = messages[last];
					if (result.role !== "toolResult") break;
					if (!ids.delete(result.toolCallId)) break;
					last++;
				}
				if (ids.size || messages[last]?.role === "toolResult") break;
				while (mapped < last) append(messages[mapped], visible[end - 1].index, mapped + 1 === last);
				next = end;
			} else break;
		}
		state.dirty = !clean || mapped !== messages.length || next !== visible.length || pending.size !== 0;
		const reply = messages[mapped - 1];
		if (reply?.role === "assistant" && !state.dirty) {
			replies.set(state, { index: state.digests.length - 1, timestamp: reply.timestamp });
		}
	} catch {
		// Already mapped slots remain usable; the full transcript stays dirty.
	}
	return state;
}
