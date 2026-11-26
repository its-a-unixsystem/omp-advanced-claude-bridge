import type { Effort, Model } from "@oh-my-pi/pi-ai";

// Model selection, display order, effort mapping, and context-window policy.
// The picker is driven by OMP's bundled Anthropic catalog so new Claude models
// appear automatically without a hardcoded allowlist.
// Extracted from index.ts so tests can import without activating the extension.

const TWO_HUNDRED_K_CONTEXT = 200_000;
const ONE_M_CONTEXT = 1_000_000;

// The catalog ships dated snapshot ids (claude-opus-4-5-20251101, ...) alongside
// bare ids. Hide them so they never clutter the picker or steal partial matches.
function isDatedAlias(id: string): boolean {
	return /-20\d{6}$/.test(id);
}

const FAMILY_ORDER = ["fable", "mythos", "opus", "sonnet", "haiku"];

function versionRank(id: string): { family: string; tuple: [number, number] } {
	const [, family = "", major, minor] = id.split("-");
	return { family, tuple: [Number(major) || 0, Number(minor) || 0] };
}

function compareModelIds(a: string, b: string): number {
	const fa = FAMILY_ORDER.indexOf(versionRank(a).family);
	const fb = FAMILY_ORDER.indexOf(versionRank(b).family);
	const ta = fa === -1 ? FAMILY_ORDER.length : fa;
	const tb = fb === -1 ? FAMILY_ORDER.length : fb;
	if (ta !== tb) return ta - tb;
	const ra = versionRank(a).tuple;
	const rb = versionRank(b).tuple;
	if (ra[0] !== rb[0]) return rb[0] - ra[0];
	if (ra[1] !== rb[1]) return rb[1] - ra[1];
	return a.localeCompare(b);
}

type CatalogModel = Pick<Model, "id" | "name" | "reasoning" | "input" | "contextWindow" | "maxTokens" | "thinking">;

// Project the bundled catalog to the fields OMP's registerProvider expects,
// sorted newest generation first per family. Context-dependent labels are applied separately.
export function buildModels(piAiModels: readonly CatalogModel[]) {
	return piAiModels
		.filter((m) => typeof m.id === "string" && m.id.startsWith("claude-") && !isDatedAlias(m.id))
		.sort((a, b) => compareModelIds(a.id, b.id))
		.map(({ id, name, reasoning, input, contextWindow, maxTokens, thinking }) => {
			// Sonnet 4.6 and Sonnet 5 top out at Claude Code's "max" effort with no
			// separate xhigh tier; expose it as xhigh in the bridge and map to max.
			if (thinking && (id === "claude-sonnet-4-6" || id === "claude-sonnet-5")) {
				const xhigh = "xhigh" as Effort.XHigh;
				thinking = {
					...thinking,
					efforts: thinking.efforts.includes(xhigh) ? thinking.efforts : [...thinking.efforts, xhigh],
					effortMap: { ...thinking.effortMap, [xhigh]: "max" },
				};
			}
			return {
				id, name, reasoning, input, contextWindow, maxTokens, thinking,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
		});
}

// Effort levels Claude Code accepts, lowest to highest.
const CLAUDE_CODE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeCodeEffort = (typeof CLAUDE_CODE_EFFORTS)[number];

// Map an OMP thinking level onto a Claude Code effort for this model. Explicit
// effortMap overrides win; otherwise clamp to the highest supported effort in
// the model's catalog ladder. Without a ladder, fall back to the legacy mapping.
export function claudeCodeEffort(
	model: { thinking?: { efforts?: readonly string[]; effortMap?: Record<string, string> } | null },
	level: string,
): ClaudeCodeEffort | undefined {
	if (level === "off" || level === "inherit") return undefined;
	const mapped = model.thinking?.effortMap?.[level];
	if (mapped != null && (CLAUDE_CODE_EFFORTS as readonly string[]).includes(mapped)) {
		return mapped as ClaudeCodeEffort;
	}
	const wanted = level === "minimal" ? "low" : level;
	const rank = CLAUDE_CODE_EFFORTS.indexOf(wanted as ClaudeCodeEffort);
	if (rank === -1) return undefined;
	const efforts = model.thinking?.efforts;
	if (!efforts?.length) return wanted === "xhigh" ? "max" : wanted as ClaudeCodeEffort;
	for (let i = rank; i >= 0; i--) {
		if (efforts.includes(CLAUDE_CODE_EFFORTS[i])) return CLAUDE_CODE_EFFORTS[i];
	}
	return "low";
}

// User-selectable context-window policy (see provider.contextWindow in config).
//   "auto"  - per-model default policy (measured SDK behavior).
//   "1m"    - prefer 1M, requesting [1m] where needed.
//   "200k"  - prefer 200K, requesting bare model ids.
export type ContextWindowMode = "auto" | "1m" | "200k";

export type LongContextSettings = {
	plan: "pro" | "max";
	longContextExtraUsage: boolean;
	contextWindow: ContextWindowMode;
};

export type ClaudeCodeRuntimeModel = {
	cliModelId: string;
	contextWindow: number;
};

// A model as seen by the runtime resolvers. contextWindow is the catalog window
// and only decides 1M capability for models without a measured row below.
export type RuntimeModelInput = { id: string; contextWindow?: number | null };

// Measured Claude Agent SDK subscription/OAuth behavior. The `[1m]` suffix is the
// reliable way to request 1M; bare ids serve 200K, except bare Opus 4.7 which
// serves 1M and has no 200K runtime. Do not infer the default from the catalog's
// advertised contextWindow: an unentitled `[1m]` id is rejected outright (400/429),
// so only measured-good ids default to 1M.
const ONE_M_ONLY_BARE = new Set(["claude-opus-4-7"]);

const MEASURED_ONE_M_CAPABLE = new Set([
	"claude-fable-5-1",
	"claude-fable-5",
	"claude-opus-5-5",
	"claude-opus-5",
	"claude-opus-4-8",
	"claude-opus-4-7",
	"claude-opus-4-6",
	"claude-sonnet-5-5",
	"claude-sonnet-5",
	"claude-sonnet-4-6",
	"claude-haiku-5-5",
]);

const MEASURED_TWO_HUNDRED_K_ONLY = new Set(["claude-haiku-4-5"]);

// "auto" defaults to 1M for models measured to serve 1M across plans.
const AUTO_ONE_M = new Set([
	"claude-opus-5-5",
	"claude-opus-5",
	"claude-opus-4-8",
	"claude-opus-4-7",
	"claude-sonnet-5-5",
	"claude-sonnet-5",
	"claude-haiku-5-5",
]);

const PLAN_GATED_ONE_M: Record<string, (settings: LongContextSettings) => boolean> = {
	"claude-opus-4-6": (settings) => settings.plan === "max" || settings.longContextExtraUsage,
	"claude-sonnet-4-6": (settings) => settings.longContextExtraUsage,
};

function supportsOneM(model: RuntimeModelInput): boolean {
	if (MEASURED_TWO_HUNDRED_K_ONLY.has(model.id)) return false;
	return MEASURED_ONE_M_CAPABLE.has(model.id) || (model.contextWindow ?? 0) >= ONE_M_CONTEXT;
}

export function resolveClaudeCodeRuntimeModel(model: RuntimeModelInput, settings: LongContextSettings): ClaudeCodeRuntimeModel | null {
	switch (settings.contextWindow) {
		case "1m":
			return resolveForcedOneMRuntimeModel(model);
		case "200k":
			return resolveForcedTwoHundredKRuntimeModel(model);
		case "auto":
			return resolveAutoRuntimeModel(model, settings);
	}
}

function resolveAutoRuntimeModel(model: RuntimeModelInput, settings: LongContextSettings): ClaudeCodeRuntimeModel | null {
	const planGate = PLAN_GATED_ONE_M[model.id];
	const preferOneM = ONE_M_ONLY_BARE.has(model.id) || AUTO_ONE_M.has(model.id) || (planGate != null && planGate(settings));
	return preferOneM
		? resolveForcedOneMRuntimeModel(model)
		: resolveForcedTwoHundredKRuntimeModel(model);
}

function resolveForcedOneMRuntimeModel(model: RuntimeModelInput): ClaudeCodeRuntimeModel | null {
	if (!supportsOneM(model)) return null;
	const cliModelId = ONE_M_ONLY_BARE.has(model.id) ? model.id : `${model.id}[1m]`;
	return { cliModelId, contextWindow: ONE_M_CONTEXT };
}

function resolveForcedTwoHundredKRuntimeModel(model: RuntimeModelInput): ClaudeCodeRuntimeModel | null {
	if (ONE_M_ONLY_BARE.has(model.id)) return null;
	return { cliModelId: model.id, contextWindow: TWO_HUNDRED_K_CONTEXT };
}

// Split a registered picker id into its base model id and the forced window it
// encodes. Variant ids carry a "-1m"/"-200k" suffix (see buildVariantModels); the
// unsuffixed id maps to the config default. Base ids never end in those suffixes,
// so the split is unambiguous.
export function parseVariantId(id: string): { baseId: string; forced?: "1m" | "200k" } {
	if (id.endsWith("-1m")) return { baseId: id.slice(0, -3), forced: "1m" };
	if (id.endsWith("-200k")) return { baseId: id.slice(0, -5), forced: "200k" };
	return { baseId: id };
}

function resolveDefaultRuntimeModel(model: RuntimeModelInput, settings: LongContextSettings): ClaudeCodeRuntimeModel | null {
	return resolveClaudeCodeRuntimeModel(model, settings)
		?? resolveForcedOneMRuntimeModel(model)
		?? resolveForcedTwoHundredKRuntimeModel(model);
}

export function claudeCodeModelId(model: RuntimeModelInput, settings: LongContextSettings): string {
	const { baseId, forced } = parseVariantId(model.id);
	const base = { id: baseId, contextWindow: model.contextWindow };
	const runtimeModel = forced === "1m"
		? resolveForcedOneMRuntimeModel(base)
		: forced === "200k"
			? resolveForcedTwoHundredKRuntimeModel(base)
			: resolveDefaultRuntimeModel(base, settings);
	if (runtimeModel == null) {
		const requested = forced ?? settings.contextWindow;
		throw new Error(`claude-bridge: model ${model.id} has no Claude Code runtime (contextWindow=${requested})`);
	}
	return runtimeModel.cliModelId;
}

export function resolveModel<T extends { id: string }>(models: T[], input: string): T | undefined {
	const lower = input.toLowerCase();
	return models.find((m) => m.id === lower)
		?? newestPartialMatch(models.filter((m) => m.id.includes(lower)));
}

function newestPartialMatch<T extends { id: string }>(candidates: T[]): T | undefined {
	if (candidates.length === 0) return undefined;
	return candidates.reduce((best, m) => {
		const vm = versionRank(parseVariantId(m.id).baseId).tuple;
		const vbest = versionRank(parseVariantId(best.id).baseId).tuple;
		const newer = vm[0] !== vbest[0] ? vm[0] > vbest[0] : vm[1] > vbest[1];
		return newer ? m : best;
	});
}

function variantName(baseName: string, contextWindow: number): string {
	const label = contextWindow === ONE_M_CONTEXT ? "1M" : "200K";
	// Strip any window hint pi-ai already baked into the name so we don't double it.
	const base = baseName.replace(/\s*(?:\((?:1M|200K)\)|\b1M\b)\s*$/i, "").trimEnd();
	return `${base} (${label})`;
}

// Expand each model into one registered entry per context window it supports, so
// the user picks the window on demand from OMP's model picker. The unsuffixed id
// (e.g. claude-opus-4-8) maps to the config default window; every other available
// window gets a "-1m"/"-200k" suffixed id. Each entry's contextWindow must match
// the window the bridge actually requests (see claudeCodeModelId), or OMP's status
// bar and auto-compaction threshold will misreport. Both windows stay pickable
// regardless of provider.contextWindow, which only picks the default.
export function buildVariantModels<T extends { id: string; name: string; contextWindow?: number | null }>(
	models: T[],
	settings: LongContextSettings,
): T[] {
	const result: T[] = [];
	for (const m of models) {
		const available: Array<{ kind: "1m" | "200k"; contextWindow: number }> = [];
		if (resolveForcedOneMRuntimeModel(m) != null) available.push({ kind: "1m", contextWindow: ONE_M_CONTEXT });
		if (resolveForcedTwoHundredKRuntimeModel(m) != null) available.push({ kind: "200k", contextWindow: TWO_HUNDRED_K_CONTEXT });
		if (available.length === 0) continue;

		const defaultRuntime = resolveDefaultRuntimeModel(m, settings);
		const defaultKind: "1m" | "200k" = defaultRuntime?.contextWindow === ONE_M_CONTEXT ? "1m" : "200k";

		const ordered = [
			...available.filter((a) => a.kind === defaultKind),
			...available.filter((a) => a.kind !== defaultKind),
		];
		for (const { kind, contextWindow } of ordered) {
			const id = kind === defaultKind ? m.id : `${m.id}-${kind}`;
			result.push({ ...m, id, contextWindow, name: variantName(m.name, contextWindow) });
		}
	}
	return result;
}
