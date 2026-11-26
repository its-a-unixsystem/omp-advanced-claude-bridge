import test from "node:test";
import assert from "node:assert/strict";

import { describeRateLimitFailure, isSessionLimitNotice, rateLimitNotice, rateLimitResponse, RATE_LIMIT_WARN_THRESHOLD } from "../src/rate-limit.ts";

test("allowed_warning below the threshold stays silent", () => {
	assert.equal(rateLimitNotice({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.01 }), null);
	assert.equal(rateLimitNotice({ status: "allowed_warning", rateLimitType: "seven_day", utilization: (RATE_LIMIT_WARN_THRESHOLD - 1) / 100 }), null);
});

test("allowed_warning at/above the threshold warns with rounded utilization + type", () => {
	assert.deepEqual(
		rateLimitNotice({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.874 }),
		{ message: "Claude rate limit warning: 87% used (seven_day)", level: "warning" },
	);
	// exactly at the threshold still warns
	assert.ok(rateLimitNotice({ status: "allowed_warning", rateLimitType: "five_hour", utilization: RATE_LIMIT_WARN_THRESHOLD / 100 }));
});

test("allowed_warning can use the selected window but not a different window", () => {
	const info = {
		status: "allowed_warning",
		rateLimitType: "seven_day",
		unifiedWindows: {
			five_hour: { utilization: 0.01 },
			seven_day: { utilization: 0.874 },
		},
	};
	assert.deepEqual(rateLimitNotice(info), {
		message: "Claude rate limit warning: 87% used (seven_day)",
		level: "warning",
	});
	assert.equal(rateLimitNotice({ ...info, rateLimitType: "five_hour" }), null);
});

test("rejected always surfaces, regardless of utilization", () => {
	const resetsAt = 1783432800;
	const notice = rateLimitNotice({ status: "rejected", rateLimitType: "seven_day", resetsAt, utilization: 0.01 });
	assert.deepEqual(notice, {
		message: `Claude rate limited (seven_day) — resets at ${new Date(resetsAt * 1000).toLocaleTimeString()}`,
		level: "warning",
	});
});

test("rejected notices can use a selected window reset or the overage reset", () => {
	const resetsAt = 1783432800;
	const time = new Date(resetsAt * 1000).toLocaleTimeString();
	assert.equal(rateLimitNotice({
		status: "rejected",
		rateLimitType: "seven_day",
		unifiedWindows: { seven_day: { resetsAt } },
	})?.message, `Claude rate limited (seven_day) — resets at ${time}`);
	assert.equal(rateLimitNotice({
		status: "rejected",
		rateLimitType: "overage",
		resetsAt: resetsAt - 3600,
		overageResetsAt: resetsAt,
	})?.message, `Claude rate limited (overage) — resets at ${time}`);
});

test("rejected without fields falls back to 'unknown'", () => {
	assert.equal(
		rateLimitNotice({ status: "rejected" })?.message,
		"Claude rate limited (unknown) — resets at unknown",
	);
});

test("allowed / undefined / empty statuses stay silent", () => {
	assert.equal(rateLimitNotice({ status: "allowed", utilization: 0.99 }), null);
	assert.equal(rateLimitNotice(undefined), null);
	assert.equal(rateLimitNotice({}), null);
});

test("missing utilization defaults to 0 (silent)", () => {
	assert.equal(rateLimitNotice({ status: "allowed_warning", rateLimitType: "seven_day" }), null);
});

test("a custom threshold is respected", () => {
	assert.equal(rateLimitNotice({ status: "allowed_warning", utilization: 0.5 }, 60), null);
	assert.ok(rateLimitNotice({ status: "allowed_warning", utilization: 0.6 }, 60));
});

test("top-level SDK fields supply the selected usage window", () => {
	const resetsAt = 1783432800;
	assert.deepEqual(rateLimitResponse({
		status: "allowed_warning",
		rateLimitType: "five_hour",
		utilization: 0.84,
		resetsAt,
	}), {
		status: 200,
		headers: {
			"anthropic-ratelimit-unified-status": "allowed_warning",
			"anthropic-ratelimit-unified-reset": String(resetsAt),
			"anthropic-ratelimit-unified-representative-claim": "five_hour",
			"anthropic-ratelimit-unified-5h-utilization": "0.84",
			"anthropic-ratelimit-unified-5h-reset": String(resetsAt),
		},
	});
});

test("unified window snapshots retain their own readings and abbreviations", () => {
	assert.deepEqual(rateLimitResponse({
		status: "allowed",
		rateLimitType: "seven_day",
		utilization: 0.24,
		resetsAt: 1783432800,
		unifiedWindows: {
			five_hour: { utilization: 0, resetsAt: 1783432800 },
			seven_day: { utilization: 0.25, resetsAt: 1783864800, status: "allowed" },
			seven_day_overage_included: { utilization: 1.07, resetsAt: 1783864800, status: "rejected" },
			seven_day_sonnet: { utilization: 0.56 },
			seven_day_opus: undefined,
		},
	}), {
		status: 200,
		headers: {
			"anthropic-ratelimit-unified-status": "allowed",
			"anthropic-ratelimit-unified-reset": "1783432800",
			"anthropic-ratelimit-unified-representative-claim": "seven_day",
			"anthropic-ratelimit-unified-5h-utilization": "0",
			"anthropic-ratelimit-unified-5h-reset": "1783432800",
			"anthropic-ratelimit-unified-7d-utilization": "0.25",
			"anthropic-ratelimit-unified-7d-reset": "1783864800",
			"anthropic-ratelimit-unified-7d-status": "allowed",
			"anthropic-ratelimit-unified-7d_oi-utilization": "1.07",
			"anthropic-ratelimit-unified-7d_oi-reset": "1783864800",
			"anthropic-ratelimit-unified-7d_oi-status": "rejected",
			"anthropic-ratelimit-unified-seven_day_sonnet-utilization": "0.56",
		},
	});
});

test("rejected events remain HTTP 200 and report overage separately", () => {
	assert.deepEqual(rateLimitResponse({
		status: "rejected",
		rateLimitType: "overage",
		utilization: 1,
		resetsAt: 1783432800,
		overageStatus: "allowed",
		overageResetsAt: 1783864800,
	}), {
		status: 200,
		headers: {
			"anthropic-ratelimit-unified-status": "rejected",
			"anthropic-ratelimit-unified-reset": "1783432800",
			"anthropic-ratelimit-unified-representative-claim": "overage",
			"anthropic-ratelimit-unified-overage-utilization": "1",
			"anthropic-ratelimit-unified-overage-status": "allowed",
			"anthropic-ratelimit-unified-overage-reset": "1783864800",
		},
	});
});

test("reset dates are normalized to seconds without filling in omitted fields", () => {
	assert.deepEqual(rateLimitResponse({
		resetsAt: "2026-07-07T14:00:00Z",
		overageResetsAt: new Date("2026-07-07T14:00:00Z"),
		unifiedWindows: { five_hour: { resetsAt: "invalid" } },
	}), {
		status: 200,
		headers: {
			"anthropic-ratelimit-unified-reset": "1783432800",
			"anthropic-ratelimit-unified-overage-reset": "1783432800",
		},
	});
});

test("describeRateLimitFailure leads with quota exceeded and rate limit for fallback", () => {
	const msg = describeRateLimitFailure({ rateLimitType: "five_hour", resetsAt: 1_700_000_000 }, "You've hit your session limit");
	assert.match(msg, /^Claude quota exceeded — rate limit \(five_hour\) — resets .+: You've hit your session limit$/);
	assert.equal(describeRateLimitFailure({}, "limit"), "Claude quota exceeded — rate limit: limit");
});

test("isSessionLimitNotice matches Claude Code limit notices only", () => {
	assert.equal(isSessionLimitNotice("You've hit your session limit · resets 5pm"), true);
	assert.equal(isSessionLimitNotice("  You've hit your limit · resets 5pm"), true);
	assert.equal(isSessionLimitNotice("You're out of extra usage · resets 6:30pm"), true);
	assert.equal(isSessionLimitNotice("Here is how rate limits work."), false);
});
