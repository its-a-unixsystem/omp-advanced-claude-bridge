import type { ProviderResponseMetadata } from "@oh-my-pi/pi-ai";

const UNIFIED_HEADER_PREFIX = "anthropic-ratelimit-unified-";

export const RATE_LIMIT_WARN_THRESHOLD = 80;

interface RateLimitWindow {
	status?: string;
	// The SDK uses fractions (which can exceed 1) and Unix seconds.
	// Also accept ISO strings and Dates for resets.
	utilization?: number;
	resetsAt?: string | number | Date;
}

export interface RateLimitInfo extends RateLimitWindow {
	rateLimitType?: string;
	overageStatus?: string;
	overageResetsAt?: RateLimitWindow["resetsAt"];
	// Claude Code sends this field, but some SDK versions omit it from their types.
	unifiedWindows?: Record<string, RateLimitWindow | undefined>;
}

export interface RateLimitNotice {
	message: string;
	level: "warning";
}

function resetSeconds(reset: RateLimitWindow["resetsAt"]): number | undefined {
	const seconds = typeof reset === "number" ? reset
		: typeof reset === "string" ? Math.floor(Date.parse(reset) / 1000)
		: reset instanceof Date ? Math.floor(reset.getTime() / 1000)
		: undefined;
	return Number.isFinite(seconds) ? seconds : undefined;
}

function windowAbbreviation(name: string): string {
	switch (name) {
		case "five_hour": return "5h";
		case "seven_day": return "7d";
		case "seven_day_overage_included": return "7d_oi";
		case "seven_day_sonnet": return "7d_sonnet";
		case "seven_day_opus": return "7d_opus";
		default: return name;
	}
}

export function rateLimitResponse(info: RateLimitInfo): ProviderResponseMetadata {
	const headers: Record<string, string> = {};
	const set = (name: string, value: string | number | undefined) => {
		if (typeof value === "string" || Number.isFinite(value)) {
			headers[`${UNIFIED_HEADER_PREFIX}${name}`] = String(value);
		}
	};

	const reset = resetSeconds(info.resetsAt);
	set("status", info.status);
	set("reset", reset);
	set("representative-claim", info.rateLimitType);

	// Older SDKs report only the selected window. A window snapshot supersedes
	// its top-level values where the snapshot actually has a reading.
	if (info.rateLimitType) {
		const name = windowAbbreviation(info.rateLimitType);
		set(`${name}-utilization`, info.utilization);
		set(`${name}-reset`, reset);
	}
	if (info.unifiedWindows) {
		for (const [name, window] of Object.entries(info.unifiedWindows)) {
			if (!window) continue;
			const abbreviation = windowAbbreviation(name);
			set(`${abbreviation}-utilization`, window.utilization);
			set(`${abbreviation}-reset`, resetSeconds(window.resetsAt));
			set(`${abbreviation}-status`, window.status);
		}
	}
	set("overage-status", info.overageStatus);
	set("overage-reset", resetSeconds(info.overageResetsAt));

	// An SDK event is not an HTTP failure; even a rejected plan can use overage.
	return { status: 200, headers };
}

// The SDK emits `allowed_warning` rate-limit events even at trivial utilization
// (e.g. 1% of the seven_day window), so those are suppressed below the threshold;
// `rejected` (hard limit) always surfaces. Returns null when nothing should show.
export function rateLimitNotice(
	info: RateLimitInfo | undefined,
	threshold: number = RATE_LIMIT_WARN_THRESHOLD,
): RateLimitNotice | null {
	const selected = info?.rateLimitType ? info.unifiedWindows?.[info.rateLimitType] : undefined;
	if (info?.status === "rejected") {
		const overageReset = info.rateLimitType === "overage" ? resetSeconds(info.overageResetsAt) : undefined;
		const seconds = overageReset ?? resetSeconds(selected?.resetsAt) ?? resetSeconds(info.resetsAt);
		const resetsAt = seconds === undefined ? "unknown" : new Date(seconds * 1000).toLocaleTimeString();
		return { message: `Claude rate limited (${info.rateLimitType ?? "unknown"}) — resets at ${resetsAt}`, level: "warning" };
	}
	if (info?.status === "allowed_warning") {
		const fraction = selected?.utilization ?? info.utilization ?? 0;
		const utilization = Math.round(fraction * 100);
		if (Number.isFinite(utilization) && utilization >= threshold) {
			return { message: `Claude rate limit warning: ${utilization}% used (${info.rateLimitType ?? ""})`, level: "warning" };
		}
	}
	return null;
}

export interface RateLimitRejection {
	rateLimitType?: string;
	resetsAt?: number;
}

// Leading with "Claude quota exceeded — rate limit" keeps both phrases in any
// truncated render: "quota exceeded" prevents OMP from retrying a multi-hour
// window, while "rate limit" lets fallback chains switch models immediately.
export function describeRateLimitFailure(rejection: RateLimitRejection, failure: string): string {
	const kind = rejection.rateLimitType ? ` (${rejection.rateLimitType})` : "";
	const resets = rejection.resetsAt
		? ` — resets ${new Date(rejection.resetsAt * 1000).toLocaleTimeString()}`
		: "";
	return `Claude quota exceeded — rate limit${kind}${resets}: ${failure}`;
}

export function isSessionLimitNotice(text: string): boolean {
	return /^you've hit your (?:session )?limit\b|^you're out of extra usage\b/i.test(text.trim());
}
