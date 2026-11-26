import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionState } from "./history-sync.js";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;

// Registrations in the same process can share an agent directory.
const activeOwners = new Map<string, { owner: object }>();

function isState(value: unknown): value is SessionState {
	if (value === null || typeof value !== "object") return false;
	const s = value as Partial<SessionState>;
	return typeof s.sessionId === "string" && UUID.test(s.sessionId)
		&& typeof s.cwd === "string" && typeof s.claudeDir === "string"
		&& typeof s.promptDigest === "string" && DIGEST.test(s.promptDigest)
		&& typeof s.dirty === "boolean"
		&& typeof s.tailUuid === "string" && UUID.test(s.tailUuid)
		&& !!s.stamp && Number.isSafeInteger(s.stamp.size) && s.stamp.size > 0
		&& Number.isFinite(s.stamp.mtimeMs) && Number.isFinite(s.stamp.ctimeMs)
		&& typeof s.stamp.digest === "string" && DIGEST.test(s.stamp.digest)
		&& Array.isArray(s.digests) && Array.isArray(s.uuids) && Array.isArray(s.cuttable) && Array.isArray(s.cutDigests)
		&& s.uuids.length === s.digests.length && s.cuttable.length === s.digests.length
		&& s.cutDigests.length === s.digests.length
		&& s.digests.every((digest, i) => typeof digest === "string" && DIGEST.test(digest)
			&& typeof s.cuttable![i] === "boolean" && (s.uuids![i] === null ? !s.cuttable![i]
				: typeof s.uuids![i] === "string" && UUID.test(s.uuids![i]!))
			&& (s.cuttable![i] ? typeof s.cutDigests![i] === "string" && DIGEST.test(s.cutDigests![i]!)
				: s.cutDigests![i] === null));
}

export class SessionStore {
	constructor(readonly directory: string, private readonly onError?: (error: unknown) => void) {}

	acquire(id: string, owner: object): (() => void) | undefined {
		if (!UUID.test(id)) return;
		const path = join(this.directory, `${id}.json`);
		const existing = activeOwners.get(path);
		if (existing && existing.owner !== owner) return;
		const lease = { owner };
		activeOwners.set(path, lease);
		return () => {
			if (activeOwners.get(path) === lease) activeOwners.delete(path);
		};
	}

	load(id: string): SessionState | null {
		if (!UUID.test(id)) return null;
		try {
			const data = JSON.parse(readFileSync(join(this.directory, `${id}.json`), "utf8"));
			return data?.version === 2 && isState(data.state) ? data.state : null;
		} catch {
			return null;
		}
	}

	save(id: string, state: SessionState): void {
		if (!UUID.test(id) || !state.stamp) return;
		const path = join(this.directory, `${id}.json`);
		const temp = `${path}.${randomUUID()}.tmp`;
		try {
			mkdirSync(this.directory, { recursive: true, mode: 0o700 });
			writeFileSync(temp, JSON.stringify({ version: 2, state }), { flag: "wx", mode: 0o600 });
			renameSync(temp, path);
		} catch (error) {
			this.onError?.(error);
			try { rmSync(temp, { force: true }); } catch {}
		}
	}
}
