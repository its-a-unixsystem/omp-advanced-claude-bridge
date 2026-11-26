import test from "node:test";
import assert from "node:assert/strict";

import { describeRateLimitFailure, isSessionLimitNotice, rateLimitNotice, RATE_LIMIT_WARN_THRESHOLD } from "../src/rate-limit.ts";

test("allowed_warning below the threshold stays silent", () => {
	assert.equal(rateLimitNotice({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 1 }), null);
	assert.equal(rateLimitNotice({ status: "allowed_warning", rateLimitType: "seven_day", utilization: RATE_LIMIT_WARN_THRESHOLD - 1 }), null);
});

test("allowed_warning at/above the threshold warns with rounded utilization + type", () => {
	assert.deepEqual(
		rateLimitNotice({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 87.4 }),
		{ message: "Claude rate limit warning: 87% used (seven_day)", level: "warning" },
	);
	// exactly at the threshold still warns
	assert.ok(rateLimitNotice({ status: "allowed_warning", rateLimitType: "five_hour", utilization: RATE_LIMIT_WARN_THRESHOLD }));
});

test("rejected always surfaces, regardless of utilization", () => {
	const notice = rateLimitNotice({ status: "rejected", rateLimitType: "seven_day", resetsAt: "2026-07-07T14:00:00Z" });
	assert.equal(notice?.level, "warning");
	assert.match(notice.message, /^Claude rate limited \(seven_day\) — resets at /);
});

test("rejected without fields falls back to 'unknown'", () => {
	assert.equal(
		rateLimitNotice({ status: "rejected" })?.message,
		"Claude rate limited (unknown) — resets at unknown",
	);
});

test("allowed / undefined / empty statuses stay silent", () => {
	assert.equal(rateLimitNotice({ status: "allowed", utilization: 99 }), null);
	assert.equal(rateLimitNotice(undefined), null);
	assert.equal(rateLimitNotice({}), null);
});

test("missing utilization defaults to 0 (silent)", () => {
	assert.equal(rateLimitNotice({ status: "allowed_warning", rateLimitType: "seven_day" }), null);
});

test("a custom threshold is respected", () => {
	assert.equal(rateLimitNotice({ status: "allowed_warning", utilization: 50 }, 60), null);
	assert.ok(rateLimitNotice({ status: "allowed_warning", utilization: 60 }, 60));
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
