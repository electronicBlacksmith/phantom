import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { MIGRATIONS } from "../../db/schema.ts";
import { processBatch } from "../batch-processor.ts";
import { DEFAULT_CADENCE_CONFIG, EvolutionCadence, loadCadenceConfig } from "../cadence.ts";
import type { EvolutionConfig } from "../config.ts";
import type { EvolutionEngine } from "../engine.ts";
import type { GateDecision } from "../gate-types.ts";
import { EvolutionQueue } from "../queue.ts";
import type { EvolutionResult, SessionSummary } from "../types.ts";

// Phase 2 cadence + batch processor tests.

const TEST_DIR = "/tmp/phantom-test-cadence";

function setupEnv(): EvolutionConfig {
	mkdirSync(`${TEST_DIR}/phantom-config/meta`, { recursive: true });
	writeFileSync(`${TEST_DIR}/phantom-config/meta/metrics.json`, "{}", "utf-8");
	return {
		cadence: { reflection_interval: 1, consolidation_interval: 10, full_review_interval: 50, drift_check_interval: 20 },
		gates: { drift_threshold: 0.7, max_file_lines: 200, auto_rollback_threshold: 0.1, auto_rollback_window: 5 },
		reflection: { model: "claude-sonnet-4-20250514", effort: "high", max_budget_usd: 0.5 },
		judges: { enabled: "always", cost_cap_usd_per_day: 50.0, max_golden_suite_size: 50 },
		paths: {
			config_dir: `${TEST_DIR}/phantom-config`,
			constitution: `${TEST_DIR}/phantom-config/constitution.md`,
			version_file: `${TEST_DIR}/phantom-config/meta/version.json`,
			metrics_file: `${TEST_DIR}/phantom-config/meta/metrics.json`,
			evolution_log: `${TEST_DIR}/phantom-config/meta/evolution-log.jsonl`,
			golden_suite: `${TEST_DIR}/phantom-config/meta/golden-suite.jsonl`,
			session_log: `${TEST_DIR}/phantom-config/memory/session-log.jsonl`,
		},
	};
}

function newDb(): Database {
	const db = new Database(":memory:");
	db.run("PRAGMA journal_mode = WAL");
	for (const stmt of MIGRATIONS) db.run(stmt);
	return db;
}

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		session_id: "s1",
		session_key: "slack:C1:T1",
		user_id: "u1",
		user_messages: ["help"],
		assistant_messages: ["ok"],
		tools_used: ["Read"],
		files_tracked: [],
		outcome: "success",
		cost_usd: 0.04,
		started_at: "2026-04-14T10:00:00Z",
		ended_at: "2026-04-14T10:01:00Z",
		...overrides,
	};
}

const DECISION: GateDecision = {
	fire: true,
	source: "haiku",
	reason: "haiku said evolve",
	haiku_cost_usd: 0.0006,
};

function fakeEngine(options: {
	onRun?: (session: SessionSummary) => Promise<EvolutionResult>;
}): EvolutionEngine {
	const calls: SessionSummary[] = [];
	const run =
		options.onRun ??
		(async (): Promise<EvolutionResult> => ({ version: 0, changes_applied: [], changes_rejected: [] }));
	const shape = {
		runSingleSessionPipeline: async (session: SessionSummary) => {
			calls.push(session);
			return run(session);
		},
		calls,
	};
	return shape as unknown as EvolutionEngine;
}

describe("loadCadenceConfig", () => {
	beforeEach(() => setupEnv());
	afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

	test("returns defaults when evolution.json is absent", () => {
		const config = setupEnv();
		const cadence = loadCadenceConfig(config);
		expect(cadence).toEqual(DEFAULT_CADENCE_CONFIG);
	});

	test("reads cadence_minutes and demand_trigger_depth overrides", () => {
		const config = setupEnv();
		writeFileSync(
			`${TEST_DIR}/phantom-config/meta/evolution.json`,
			JSON.stringify({ cadence_minutes: 240, demand_trigger_depth: 10 }),
			"utf-8",
		);
		const cadence = loadCadenceConfig(config);
		expect(cadence.cadenceMinutes).toBe(240);
		expect(cadence.demandTriggerDepth).toBe(10);
	});

	test("falls back to defaults on malformed evolution.json", () => {
		const config = setupEnv();
		writeFileSync(`${TEST_DIR}/phantom-config/meta/evolution.json`, "{not json", "utf-8");
		const cadence = loadCadenceConfig(config);
		expect(cadence).toEqual(DEFAULT_CADENCE_CONFIG);
	});
});

describe("processBatch", () => {
	beforeEach(() => setupEnv());
	afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

	test("runs the pipeline per queued session and returns per-row results", async () => {
		const db = newDb();
		const queue = new EvolutionQueue(db);
		queue.enqueue(makeSummary({ session_id: "a" }), DECISION);
		queue.enqueue(makeSummary({ session_id: "b" }), DECISION);
		const drained = queue.drainAll();

		const sessionsSeen: string[] = [];
		const engine = fakeEngine({
			onRun: async (session) => {
				sessionsSeen.push(session.session_id);
				return { version: 1, changes_applied: [], changes_rejected: [] };
			},
		});

		const result = await processBatch(drained, engine);
		expect(result.processed).toBe(2);
		expect(result.successCount).toBe(2);
		expect(result.failureCount).toBe(0);
		expect(sessionsSeen).toEqual(["a", "b"]);
	});

	test("records a failure entry for a throwing session and continues", async () => {
		const db = newDb();
		const queue = new EvolutionQueue(db);
		queue.enqueue(makeSummary({ session_id: "a" }), DECISION);
		queue.enqueue(makeSummary({ session_id: "b" }), DECISION);
		const drained = queue.drainAll();

		let calls = 0;
		const engine = fakeEngine({
			onRun: async () => {
				calls += 1;
				if (calls === 1) throw new Error("boom");
				return { version: 1, changes_applied: [], changes_rejected: [] };
			},
		});

		const result = await processBatch(drained, engine);
		expect(result.processed).toBe(2);
		expect(result.successCount).toBe(1);
		expect(result.failureCount).toBe(1);
		const failure = result.results.find((r) => !r.ok);
		expect(failure).toBeDefined();
		if (failure && !failure.ok) {
			expect(failure.error).toContain("boom");
		}
	});
});

describe("EvolutionCadence", () => {
	beforeEach(() => setupEnv());
	afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

	test("demand trigger fires drainAndProcess when queue depth hits threshold", async () => {
		const config = setupEnv();
		const db = newDb();
		const queue = new EvolutionQueue(db);
		const engine = fakeEngine({});
		const cadence = new EvolutionCadence(engine, queue, config, { cadenceMinutes: 1_000_000, demandTriggerDepth: 3 });
		cadence.start();
		try {
			for (let i = 0; i < 3; i++) {
				queue.enqueue(makeSummary({ session_id: `s${i}` }), DECISION);
				cadence.onEnqueue();
			}
			// Allow any in-flight drain promise to settle before asserting.
			await new Promise((r) => setTimeout(r, 50));
			expect(queue.depth()).toBe(0);
		} finally {
			cadence.stop();
		}
	});

	test("demand trigger does not fire below the threshold", async () => {
		const config = setupEnv();
		const db = newDb();
		const queue = new EvolutionQueue(db);
		const engine = fakeEngine({});
		const cadence = new EvolutionCadence(engine, queue, config, { cadenceMinutes: 1_000_000, demandTriggerDepth: 5 });
		cadence.start();
		try {
			queue.enqueue(makeSummary({ session_id: "s1" }), DECISION);
			cadence.onEnqueue();
			await new Promise((r) => setTimeout(r, 20));
			expect(queue.depth()).toBe(1);
		} finally {
			cadence.stop();
		}
	});

	test("triggerNow drains the queue and marks rows processed", async () => {
		const config = setupEnv();
		const db = newDb();
		const queue = new EvolutionQueue(db);
		const engine = fakeEngine({});
		const cadence = new EvolutionCadence(engine, queue, config, { cadenceMinutes: 1_000_000, demandTriggerDepth: 999 });
		cadence.start();
		try {
			queue.enqueue(makeSummary({ session_id: "s1" }), DECISION);
			queue.enqueue(makeSummary({ session_id: "s2" }), DECISION);
			const result = await cadence.triggerNow();
			expect(result).not.toBeNull();
			expect(result?.processed).toBe(2);
			expect(queue.depth()).toBe(0);
		} finally {
			cadence.stop();
		}
	});

	test("skip on mutex contention: second concurrent trigger returns null without re-running", async () => {
		const config = setupEnv();
		const db = newDb();
		const queue = new EvolutionQueue(db);
		let runs = 0;
		const engine = fakeEngine({
			onRun: async () => {
				runs += 1;
				await new Promise((r) => setTimeout(r, 30));
				return { version: 0, changes_applied: [], changes_rejected: [] };
			},
		});
		const cadence = new EvolutionCadence(engine, queue, config, { cadenceMinutes: 1_000_000, demandTriggerDepth: 999 });
		cadence.start();
		try {
			queue.enqueue(makeSummary({ session_id: "slow-1" }), DECISION);
			queue.enqueue(makeSummary({ session_id: "slow-2" }), DECISION);
			const first = cadence.triggerNow();
			// Second call arrives while the first is still in flight. The
			// skip-on-contention rule says this one must return null and must
			// NOT spawn a parallel batch.
			const second = await cadence.triggerNow();
			expect(second).toBeNull();
			const firstResult = await first;
			expect(firstResult?.processed).toBe(2);
			// Each queued row is processed exactly once. The skipped second
			// trigger did not re-drain the queue.
			expect(runs).toBe(2);
		} finally {
			cadence.stop();
		}
	});

	test("triggerNow returns null on an empty queue", async () => {
		const config = setupEnv();
		const db = newDb();
		const queue = new EvolutionQueue(db);
		const engine = fakeEngine({});
		const cadence = new EvolutionCadence(engine, queue, config, DEFAULT_CADENCE_CONFIG);
		cadence.start();
		try {
			const result = await cadence.triggerNow();
			expect(result).toBeNull();
		} finally {
			cadence.stop();
		}
	});

	test("cron tick fires drainAndProcess after the timer elapses", async () => {
		const config = setupEnv();
		const db = newDb();
		const queue = new EvolutionQueue(db);
		const engine = fakeEngine({});
		// cadenceMinutes is stored as minutes but the scheduler multiplies by
		// 60_000; passing 1/60000 gives a 1 ms tick which is enough to run in
		// a test without leaking real wall-clock time.
		const cadence = new EvolutionCadence(engine, queue, config, {
			cadenceMinutes: 1 / 60_000,
			demandTriggerDepth: 999,
		});
		cadence.start();
		try {
			queue.enqueue(makeSummary({ session_id: "cron-1" }), DECISION);
			// Wait long enough for the cron timer to fire.
			await new Promise((r) => setTimeout(r, 40));
			expect(queue.depth()).toBe(0);
		} finally {
			cadence.stop();
		}
	});

	test("queue_stats counters increment after each drain", async () => {
		const config = setupEnv();
		const db = newDb();
		const queue = new EvolutionQueue(db);
		const engine = fakeEngine({});
		const cadence = new EvolutionCadence(engine, queue, config, { cadenceMinutes: 1_000_000, demandTriggerDepth: 999 });
		cadence.start();
		try {
			queue.enqueue(makeSummary({ session_id: "m1" }), DECISION);
			queue.enqueue(makeSummary({ session_id: "m2" }), DECISION);
			await cadence.triggerNow();
			const metrics = JSON.parse(readFileSync(config.paths.metrics_file, "utf-8"));
			expect(metrics.queue_stats).toBeDefined();
			expect(metrics.queue_stats.manual_fires_total).toBe(1);
			expect(metrics.queue_stats.batch_size_total).toBe(2);
			expect(metrics.queue_stats.avg_depth_at_drain).toBeCloseTo(2, 5);
		} finally {
			cadence.stop();
		}
	});

	test("stop clears the cron timer so no further ticks fire", async () => {
		const config = setupEnv();
		const db = newDb();
		const queue = new EvolutionQueue(db);
		const engine = fakeEngine({});
		const cadence = new EvolutionCadence(engine, queue, config, {
			cadenceMinutes: 1 / 60_000,
			demandTriggerDepth: 999,
		});
		cadence.start();
		cadence.stop();
		queue.enqueue(makeSummary({ session_id: "post-stop" }), DECISION);
		await new Promise((r) => setTimeout(r, 40));
		// The timer was cleared so the cron cannot drain the queue after stop.
		expect(queue.depth()).toBe(1);
	});
});
