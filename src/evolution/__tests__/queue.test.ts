import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../../db/schema.ts";
import type { GateDecision } from "../gate-types.ts";
import { EvolutionQueue } from "../queue.ts";
import type { SessionSummary } from "../types.ts";

// Phase 2 queue tests. Cover SQLite migration, enqueue persistence, drain
// ordering, markProcessed, Zod schema validation on read, and the
// process-restart survival case that justifies the SQLite backing in the
// first place.

function newDb(): Database {
	const db = new Database(":memory:");
	db.run("PRAGMA journal_mode = WAL");
	for (const stmt of MIGRATIONS) {
		db.run(stmt);
	}
	return db;
}

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		session_id: "s1",
		session_key: "slack:C1:T1",
		user_id: "u1",
		user_messages: ["help me"],
		assistant_messages: ["sure"],
		tools_used: ["Read"],
		files_tracked: [],
		outcome: "success",
		cost_usd: 0.05,
		started_at: "2026-04-14T10:00:00Z",
		ended_at: "2026-04-14T10:03:00Z",
		...overrides,
	};
}

const DECISION: GateDecision = {
	fire: true,
	source: "haiku",
	reason: "user taught a workflow pattern",
	haiku_cost_usd: 0.0006,
};

describe("EvolutionQueue", () => {
	let db: Database;

	beforeEach(() => {
		db = newDb();
	});

	test("migration created the evolution_queue table", () => {
		const row = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='evolution_queue'").get() as {
			name: string;
		} | null;
		expect(row).not.toBeNull();
		expect(row?.name).toBe("evolution_queue");
	});

	test("enqueue inserts a row and depth reflects the insert", () => {
		const queue = new EvolutionQueue(db);
		expect(queue.depth()).toBe(0);
		queue.enqueue(makeSummary(), DECISION);
		expect(queue.depth()).toBe(1);
	});

	test("drainAll returns rows oldest-first", () => {
		const queue = new EvolutionQueue(db);
		queue.enqueue(makeSummary({ session_id: "a" }), DECISION);
		queue.enqueue(makeSummary({ session_id: "b" }), DECISION);
		queue.enqueue(makeSummary({ session_id: "c" }), DECISION);
		const drained = queue.drainAll();
		expect(drained).toHaveLength(3);
		expect(drained[0].session_id).toBe("a");
		expect(drained[1].session_id).toBe("b");
		expect(drained[2].session_id).toBe("c");
	});

	test("drainAll returns empty array on empty queue", () => {
		const queue = new EvolutionQueue(db);
		expect(queue.drainAll()).toHaveLength(0);
	});

	test("markProcessed deletes only the specified ids", () => {
		const queue = new EvolutionQueue(db);
		queue.enqueue(makeSummary({ session_id: "a" }), DECISION);
		queue.enqueue(makeSummary({ session_id: "b" }), DECISION);
		queue.enqueue(makeSummary({ session_id: "c" }), DECISION);
		const drained = queue.drainAll();
		queue.markProcessed([drained[0].id, drained[2].id]);
		const remaining = queue.drainAll();
		expect(remaining).toHaveLength(1);
		expect(remaining[0].session_id).toBe("b");
	});

	test("Zod validates the decoded gate decision and session summary", () => {
		const queue = new EvolutionQueue(db);
		queue.enqueue(makeSummary(), DECISION);
		const drained = queue.drainAll();
		expect(drained[0].gate_decision.fire).toBe(true);
		expect(drained[0].gate_decision.source).toBe("haiku");
		expect(drained[0].session_summary.user_messages).toEqual(["help me"]);
	});

	test("row survives a reopened database connection", () => {
		// SQLite in-memory databases do not persist across connections, so we
		// use a shared `:memory:?cache=shared` style via an explicit file path
		// that lives for the duration of the test.
		const path = `/tmp/phantom-test-queue-${process.pid}-${Date.now()}.sqlite`;
		try {
			const db1 = new Database(path, { create: true });
			for (const stmt of MIGRATIONS) db1.run(stmt);
			const q1 = new EvolutionQueue(db1);
			q1.enqueue(makeSummary({ session_id: "survivor" }), DECISION);
			db1.close();

			const db2 = new Database(path);
			const q2 = new EvolutionQueue(db2);
			const rows = q2.drainAll();
			expect(rows).toHaveLength(1);
			expect(rows[0].session_id).toBe("survivor");
			db2.close();
		} finally {
			try {
				require("node:fs").rmSync(path, { force: true });
			} catch {
				// best-effort cleanup
			}
		}
	});

	test("clear truncates the queue", () => {
		const queue = new EvolutionQueue(db);
		queue.enqueue(makeSummary(), DECISION);
		queue.enqueue(makeSummary(), DECISION);
		queue.clear();
		expect(queue.depth()).toBe(0);
	});
});
