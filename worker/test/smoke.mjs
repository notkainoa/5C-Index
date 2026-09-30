// 5C-Index proxy — local smoke harness (node 24, no dependencies).
//
// Run:  node worker/test/smoke.mjs        (from the repo root)
// Stubs R2/KV with in-memory fakes, stubs the upstream with the saved
// /tmp fixture plus scripted 304/404/500 sequences. Imports the real
// worker sources (../src/*.ts) via node 24 type-stripping, so every
// assertion exercises production code paths.
//
// TAP-ish output; exit 0 iff every test passes.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
	clearInFlight,
	kvAcquire,
	kvRelease,
	singleFlight,
} from "../src/coalesce.ts";
import { handleRequest, resetRateLimits } from "../src/index.ts";
import {
	fullPrewarm,
	isQuickCron,
	refreshTerm,
	scheduled,
} from "../src/prewarm.ts";
import { MemoryStorage, R2KVStorage, sha1Hex } from "../src/store.ts";
import { fetchBanana, isStaleOnly, resetCircuit } from "../src/upstream.ts";

const FIXTURE_PATH = "/tmp/5c-sections-FA2026.json";
const TERM = "FA2026";
const ETAG_1 = 'W/"snap-1"';
const ETAG_2 = 'W/"snap-2"';

// ---------- fakes ----------

class FakeR2 {
	constructor() {
		this.m = new Map();
	}
	async get(k) {
		const e = this.m.get(k);
		if (!e) return null;
		return { text: async () => e.body, httpEtag: e.etag };
	}
	async put(k, v, opts = {}) {
		this.m.set(k, { body: String(v), etag: opts.httpEtag ?? null });
	}
}

class FakeKV {
	constructor() {
		this.m = new Map();
	}
	async get(k, type) {
		const e = this.m.get(k);
		if (!e) return null;
		if (e.exp !== 0 && Date.now() > e.exp) {
			this.m.delete(k);
			return null;
		}
		if (type === "json") {
			try {
				return JSON.parse(e.v);
			} catch {
				return null;
			}
		}
		return e.v;
	}
	async put(k, v, opts = {}) {
		this.m.set(k, {
			v: String(v),
			exp: opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0,
		});
	}
	async delete(k) {
		this.m.delete(k);
	}
}

function makeEnv() {
	return { SNAPSHOTS: new FakeR2(), META: new FakeKV(), CURRENT_TERM: TERM };
}

function makeCtx() {
	const pending = [];
	return {
		ctx: {
			waitUntil(p) {
				pending.push(Promise.resolve(p).catch(() => null));
			},
		},
		async drain() {
			while (pending.length) await pending.shift();
		},
	};
}

function req(path, { ip = "9.9.9.9", headers = {} } = {}) {
	return new Request(`https://proxy.test${path}`, {
		headers: { "cf-connecting-ip": ip, ...headers },
	});
}

function jsonResponse(value, { status = 200, etag = null, extra = {} } = {}) {
	const headers = { "content-type": "application/json", ...extra };
	if (etag) headers.etag = etag;
	const body = status === 204 || status === 304 ? null : JSON.stringify(value);
	return new Response(body, { status, headers });
}

/** Scripted upstream: each call consumes the next handler (last repeats). */
function scripted(handlers, { delayMs = 0 } = {}) {
	let calls = 0;
	const fn = async (url, init) => {
		calls += 1;
		if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
		const h = handlers[Math.min(calls - 1, handlers.length - 1)];
		return h(url, init, calls);
	};
	fn.calls = () => calls;
	return fn;
}

const okSections = (body, etag) => () =>
	jsonResponse(JSON.parse(body), { etag });

// ---------- runner ----------

const results = [];
async function t(name, fn) {
	resetRateLimits();
	clearInFlight();
	resetCircuit();
	try {
		await fn();
		results.push({ name, ok: true });
	} catch (err) {
		results.push({ name, ok: false, err });
	}
}

const fixture = await readFile(FIXTURE_PATH, "utf8");
const fixtureCount = JSON.parse(fixture).length;
assert.ok(fixtureCount > 2000, "fixture looks like a full term");

// ---------- tests ----------

await t("sha1 known vector", async () => {
	assert.equal(
		await sha1Hex("abc"),
		"a9993e364706816aba3e25717850c26c9cd0d89d",
	);
});

await t("MemoryStorage snapshot/meta/kv roundtrip", async () => {
	const s = new MemoryStorage();
	await s.snapshotPut(TERM, fixture, ETAG_1);
	await s.metaPut(TERM, {
		etag: ETAG_1,
		hash: "h",
		fetched_at: "2026-09-25T00:00:00Z",
		count: 1,
	});
	assert.equal((await s.snapshotGet(TERM)).body, fixture);
	assert.equal((await s.snapshotGet(TERM)).etag, ETAG_1);
	assert.equal((await s.metaGet(TERM)).count, 1);
	assert.equal(await s.snapshotGet("NOPE2026"), null);
	await s.kvPut("k", "v", { expirationTtl: 60 });
	assert.equal(await s.kvGet("k"), "v");
	await s.kvDelete("k");
	assert.equal(await s.kvGet("k"), null);
});

await t("R2KVStorage adapter roundtrip (FakeR2/FakeKV)", async () => {
	const env = makeEnv();
	const s = new R2KVStorage(env);
	await s.snapshotPut(TERM, fixture, ETAG_1);
	await s.metaPut(TERM, {
		etag: ETAG_1,
		hash: "h",
		fetched_at: "2026-09-25T00:00:00Z",
		count: 5,
	});
	const snap = await s.snapshotGet(TERM);
	assert.equal(snap.etag, ETAG_1);
	assert.equal(JSON.parse(snap.body).length, fixtureCount);
	assert.equal((await s.metaGet(TERM)).hash, "h");
	assert.equal(await s.metaGet("NOPE2026"), null);
});

await t("cache MISS then HIT (one upstream call)", async () => {
	const env = makeEnv();
	const upstream = scripted([okSections(fixture, ETAG_1)]);
	const nowMs = Date.now();
	const deps = { fetchFn: upstream, now: () => nowMs };
	const r1 = await handleRequest(
		req("/snapshot/FA2026.json", { ip: "t-hit" }),
		env,
		makeCtx().ctx,
		deps,
	);
	assert.equal(r1.status, 200);
	assert.equal(r1.headers.get("etag"), ETAG_1);
	assert.equal(r1.headers.get("x-5c-stale"), "false");
	assert.equal(r1.headers.get("access-control-allow-origin"), "*");
	assert.match(r1.headers.get("cache-control"), /max-age=60/);
	assert.ok(r1.headers.get("last-modified"));
	const r2 = await handleRequest(
		req("/snapshot/FA2026.json", { ip: "t-hit" }),
		env,
		makeCtx().ctx,
		deps,
	);
	assert.equal(r2.status, 200);
	assert.equal(await r2.text(), await r1.text());
	assert.equal(upstream.calls(), 1);
	// /meta/:term.json reflects the write
	const m = await handleRequest(
		req("/meta/FA2026.json", { ip: "t-hit" }),
		env,
		makeCtx().ctx,
		deps,
	);
	assert.equal(m.status, 200);
	const meta = await m.json();
	assert.equal(meta.etag, ETAG_1);
	assert.equal(meta.count, fixtureCount);
	assert.equal(meta.hash.length, 40);
});

await t("client If-None-Match -> 304", async () => {
	const env = makeEnv();
	const upstream = scripted([okSections(fixture, ETAG_1)]);
	const deps = { fetchFn: upstream };
	await handleRequest(
		req("/snapshot/FA2026.json", { ip: "t-304c" }),
		env,
		makeCtx().ctx,
		deps,
	);
	const r = await handleRequest(
		req("/snapshot/FA2026.json", {
			ip: "t-304c",
			headers: { "if-none-match": ETAG_1 },
		}),
		env,
		makeCtx().ctx,
		deps,
	);
	assert.equal(r.status, 304);
	assert.equal(upstream.calls(), 1);
});

await t("SWR background refresh (stale served, R2 updated)", async () => {
	const env = makeEnv();
	let nowMs = Date.now();
	const upstream = scripted([
		okSections(fixture, ETAG_1),
		okSections(fixture, ETAG_2),
	]);
	const deps = { fetchFn: upstream, now: () => nowMs };
	await handleRequest(
		req("/snapshot/FA2026.json", { ip: "t-swr" }),
		env,
		makeCtx().ctx,
		deps,
	);
	nowMs += 125_000; // past the 60 s TTL
	const { ctx, drain } = makeCtx();
	const stale = await handleRequest(
		req("/snapshot/FA2026.json", { ip: "t-swr" }),
		env,
		ctx,
		deps,
	);
	assert.equal(stale.status, 200);
	assert.equal(stale.headers.get("x-5c-stale"), "true");
	await drain(); // background revalidation completes
	assert.equal(upstream.calls(), 2);
	const fresh = await handleRequest(
		req("/snapshot/FA2026.json", { ip: "t-swr" }),
		env,
		makeCtx().ctx,
		deps,
	);
	assert.equal(fresh.headers.get("x-5c-stale"), "false");
	assert.equal(fresh.headers.get("etag"), ETAG_2);
	assert.equal(upstream.calls(), 2);
});

await t("upstream 304 passthrough (fetched_at bump, same body)", async () => {
	const env = makeEnv();
	let nowMs = Date.now();
	const upstream = scripted([
		okSections(fixture, ETAG_1),
		() => new Response(null, { status: 304, headers: { etag: ETAG_1 } }),
	]);
	const deps = { fetchFn: upstream, now: () => nowMs };
	const h = makeCtx();
	await handleRequest(
		req("/snapshot/FA2026.json", { ip: "t-304u" }),
		env,
		h.ctx,
		deps,
	);
	const before = (await new R2KVStorage(env).metaGet(TERM)).fetched_at;
	nowMs += 125_000;
	const r = await handleRequest(
		req("/snapshot/FA2026.json", { ip: "t-304u" }),
		env,
		makeCtx().ctx,
		deps,
	);
	assert.equal(r.status, 200); // SWR path serves stale, background gets 304
	const after = (await new R2KVStorage(env).metaGet(TERM)).fetched_at;
	assert.ok(Date.parse(after) > Date.parse(before), "fetched_at bumped on 304");
	assert.equal((await new R2KVStorage(env).metaGet(TERM)).etag, ETAG_1);
});

await t("404 negative caching (5-min, one upstream call)", async () => {
	const env = makeEnv();
	let nowMs = Date.now();
	const upstream = scripted([
		() => jsonResponse({ error: "nope" }, { status: 404 }),
	]);
	const deps = { fetchFn: upstream, now: () => nowMs };
	const r1 = await handleRequest(
		req("/snapshot/FA2099.json", { ip: "t-404" }),
		env,
		makeCtx().ctx,
		deps,
	);
	assert.equal(r1.status, 404);
	const body = await r1.json();
	assert.equal(body.ok, false);
	assert.ok(body.error.code);
	assert.match(r1.headers.get("cache-control"), /max-age=300/);
	const r2 = await handleRequest(
		req("/snapshot/FA2099.json", { ip: "t-404" }),
		env,
		makeCtx().ctx,
		deps,
	);
	assert.equal(r2.status, 404);
	assert.equal(upstream.calls(), 1);
	nowMs += 301_000; // negative entry expires
	await handleRequest(
		req("/snapshot/FA2099.json", { ip: "t-404" }),
		env,
		makeCtx().ctx,
		deps,
	);
	assert.equal(upstream.calls(), 2);
});

await t("coalesced concurrent misses (20 -> 1 upstream call)", async () => {
	const env = makeEnv();
	const upstream = scripted([okSections(fixture, ETAG_1)], { delayMs: 30 });
	const deps = { fetchFn: upstream };
	const all = await Promise.all(
		Array.from({ length: 20 }, (_, i) =>
			handleRequest(
				req("/snapshot/FA2026.json", { ip: `t-coal-${i}` }),
				env,
				makeCtx().ctx,
				deps,
			),
		),
	);
	assert.ok(all.every((r) => r.status === 200));
	const bodies = await Promise.all(all.map((r) => r.text()));
	assert.ok(bodies.every((b) => b === bodies[0]));
	assert.equal(upstream.calls(), 1);
	// singleFlight unit shape
	let runs = 0;
	await Promise.all(
		Array.from({ length: 5 }, () =>
			singleFlight("unit", async () => {
				runs += 1;
				return 7;
			}),
		),
	);
	assert.equal(runs, 1);
	// KV flag acquire/release
	const kv = new MemoryStorage();
	assert.equal(await kvAcquire(kv, TERM), true);
	assert.equal(await kvAcquire(kv, TERM), false);
	await kvRelease(kv, TERM);
	assert.equal(await kvAcquire(kv, TERM), true);
});

await t("rate limit 429 with Retry-After + CLI-shaped body", async () => {
	const env = makeEnv();
	const upstream = scripted([okSections(fixture, ETAG_1)]);
	let nowMs = Date.now();
	const deps = { fetchFn: upstream, now: () => nowMs };
	const ip = "t-rate";
	for (let i = 0; i < 60; i += 1) {
		const r = await handleRequest(
			req("/terms", { ip }),
			env,
			makeCtx().ctx,
			deps,
		);
		assert.ok(r.status === 200 || r.status === 502, `request ${i} allowed`);
	}
	const limited = await handleRequest(
		req("/terms", { ip }),
		env,
		makeCtx().ctx,
		deps,
	);
	assert.equal(limited.status, 429);
	assert.ok(Number(limited.headers.get("retry-after")) > 0);
	const body = await limited.json();
	assert.equal(body.ok, false);
	assert.equal(body.error.code, "E_RATE_LIMITED");
	// window resets after 60 s
	nowMs += 61_000;
	const again = await handleRequest(
		req("/terms", { ip }),
		env,
		makeCtx().ctx,
		deps,
	);
	assert.notEqual(again.status, 429);
});

await t("circuit breaker -> stale-only, then 502 with no cache", async () => {
	const boom = scripted([
		() =>
			jsonResponse({ e: 1 }, { status: 500, extra: { "retry-after": "0" } }),
	]);
	// three consecutive 5xx trips the breaker (no-op sleep keeps it fast)
	for (let i = 0; i < 3; i += 1) {
		await fetchBanana("/v4/sections/FA2026", {
			fetchFn: boom,
			sleep: async () => {},
		});
	}
	assert.equal(isStaleOnly(), true);

	// seeded stale cache is served without touching origin
	const env = makeEnv();
	const store = new R2KVStorage(env);
	await store.snapshotPut(TERM, fixture, ETAG_1);
	await store.metaPut(TERM, {
		etag: ETAG_1,
		hash: "h",
		fetched_at: new Date(Date.now() - 600_000).toISOString(),
		count: fixtureCount,
	});
	const nowMs = Date.now();
	const origin = scripted([okSections(fixture, ETAG_2)]);
	const r = await handleRequest(
		req("/snapshot/FA2026.json", { ip: "t-cb" }),
		env,
		makeCtx().ctx,
		{ fetchFn: origin, now: () => nowMs },
	);
	assert.equal(r.status, 200);
	assert.equal(r.headers.get("x-5c-stale"), "true");
	assert.equal(origin.calls(), 0);

	// no cache + open breaker + failing origin -> 502 envelope
	const env2 = makeEnv();
	const failing = scripted([
		() =>
			jsonResponse({ e: 1 }, { status: 500, extra: { "retry-after": "0" } }),
	]);
	const r2 = await handleRequest(
		req("/snapshot/FA2026.json", { ip: "t-cb2" }),
		env2,
		makeCtx().ctx,
		{ fetchFn: failing, now: () => nowMs },
	);
	assert.equal(r2.status, 502);
	assert.equal((await r2.json()).ok, false);
});

await t("CORS on snapshot/meta/terms + terms caching", async () => {
	const env = makeEnv();
	const terms = [{ term: "FA", year: 2026 }];
	const upstream = scripted([
		(url) =>
			url.includes("/term/all")
				? jsonResponse(terms)
				: jsonResponse(JSON.parse(fixture), { etag: ETAG_1 }),
	]);
	const deps = { fetchFn: upstream };
	const s = await handleRequest(
		req("/snapshot/FA2026.json", { ip: "t-cors" }),
		env,
		makeCtx().ctx,
		deps,
	);
	const m = await handleRequest(
		req("/meta/FA2026.json", { ip: "t-cors" }),
		env,
		makeCtx().ctx,
		deps,
	);
	const t1 = await handleRequest(
		req("/terms", { ip: "t-cors" }),
		env,
		makeCtx().ctx,
		deps,
	);
	const t2 = await handleRequest(
		req("/terms", { ip: "t-cors" }),
		env,
		makeCtx().ctx,
		deps,
	);
	for (const r of [s, m, t1]) {
		assert.equal(r.headers.get("access-control-allow-origin"), "*");
	}
	assert.deepEqual(await t1.json(), terms);
	assert.deepEqual(await t2.json(), terms);
	assert.equal(
		upstream.calls(),
		2,
		"terms catalog fetched once, snapshot once",
	);
});

await t(
	"prewarm: quick cron refreshes current term; daily does full",
	async () => {
		assert.equal(isQuickCron("*/2 * * * *"), true);
		assert.equal(isQuickCron("17 6 * * *"), false);
		const env = makeEnv();
		const upstream = scripted([
			(url) =>
				url.includes("/term/all")
					? jsonResponse([
							{ term: "FA", year: 2026 },
							{ term: "SP", year: 2026 },
						])
					: url.includes("course-areas")
						? jsonResponse([{ area: "CSCI", description: "Computer Science" }])
						: jsonResponse(JSON.parse(fixture), { etag: ETAG_1 }),
		]);
		const deps = { fetchFn: upstream };
		await scheduled(
			{ cron: "*/2 * * * *", scheduledTime: Date.now() },
			env,
			deps,
		);
		const store = new R2KVStorage(env);
		assert.ok(
			(await store.snapshotGet(TERM)) !== null,
			"quick cron wrote current snapshot",
		);
		assert.equal((await store.metaGet(TERM)).count, fixtureCount);

		const env2 = makeEnv();
		const out = await fullPrewarm(env2, deps);
		assert.deepEqual(out.terms.sort(), ["FA2026", "SP2026"]);
		const store2 = new R2KVStorage(env2);
		assert.ok(await store2.snapshotGet("FA2026"));
		assert.ok(await store2.snapshotGet("SP2026"));
		assert.ok(await store2.snapshotGet("course-areas"));
		assert.ok(await store2.kvGet("terms:all"));
		// refreshTerm is a 304-safe no-op writer
		await refreshTerm("FA2026", env2, deps);
	},
);

await t("healthz, 404 envelope, OPTIONS, 405", async () => {
	const env = makeEnv();
	const deps = { fetchFn: scripted([() => jsonResponse([])]) };
	const h = await handleRequest(
		req("/healthz", { ip: "t-misc" }),
		env,
		makeCtx().ctx,
		deps,
	);
	assert.equal(h.status, 200);
	assert.equal((await h.json()).ok, true);
	const n = await handleRequest(
		req("/nope", { ip: "t-misc" }),
		env,
		makeCtx().ctx,
		deps,
	);
	assert.equal(n.status, 404);
	assert.deepEqual(Object.keys(await n.json()).sort(), ["error", "ok"]);
	const bad = await handleRequest(
		req("/snapshot/XX.json", { ip: "t-misc" }),
		env,
		makeCtx().ctx,
		deps,
	);
	assert.equal(bad.status, 404);
	assert.equal((await bad.json()).error.code, "E_BAD_TERM");
	const pre = await handleRequest(
		new Request("https://proxy.test/snapshot/FA2026.json", {
			method: "OPTIONS",
		}),
		env,
		makeCtx().ctx,
		deps,
	);
	assert.equal(pre.status, 204);
	assert.equal(pre.headers.get("access-control-allow-origin"), "*");
	const post = await handleRequest(
		new Request("https://proxy.test/snapshot/FA2026.json", { method: "POST" }),
		env,
		makeCtx().ctx,
		deps,
	);
	assert.equal(post.status, 405);
});

// ---------- report ----------

console.log("TAP version 13");
results.forEach((r, i) => {
	if (r.ok) console.log(`ok ${i + 1} - ${r.name}`);
	else
		console.log(
			`not ok ${i + 1} - ${r.name}\n  ---\n  error: ${String(r.err?.stack || r.err)}\n  ...`,
		);
});
const passed = results.filter((r) => r.ok).length;
console.log(`1..${results.length}`);
console.log(
	`# pass ${passed}/${results.length} (fixture: ${fixtureCount} sections)`,
);
process.exit(passed === results.length ? 0 : 1);
