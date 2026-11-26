export const RATE_LIMIT_WARN_THRESHOLD = 80;

export interface RateLimitInfo {
	status?: string;
	rateLimitType?: string;
	utilization?: number;
	resetsAt?: string | number | Date;
}

export interface RateLimitNotice {
	message: string;
	level: "warning";
}

// The SDK emits `allowed_warning` rate-limit events even at trivial utilization
// (e.g. 1% of the seven_day window), so those are suppressed below the threshold;
// `rejected` (hard limit) always surfaces. Returns null when nothing should show.
export function rateLimitNotice(
	info: RateLimitInfo | undefined,
	threshold: number = RATE_LIMIT_WARN_THRESHOLD,
): RateLimitNotice | null {
	if (info?.status === "rejected") {
		const resetsAt = info.resetsAt ? new Date(info.resetsAt).toLocaleTimeString() : "unknown";
		return { message: `Claude rate limited (${info.rateLimitType ?? "unknown"}) — resets at ${resetsAt}`, level: "warning" };
	}
	if (info?.status === "allowed_warning") {
		const utilization = Math.round(info.utilization ?? 0);
		if (utilization >= threshold) {
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
