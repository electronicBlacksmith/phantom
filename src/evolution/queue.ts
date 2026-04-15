import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { GateDecision } from "./gate-types.ts";
import type { SessionSummary } from "./types.ts";

// Phase 2 persistent queue. Sessions that passed `decideGate` live here until
// the cadence cron or the demand trigger drains them into `batch-processor.ts`.
//
// The rationale for SQLite over an in-memory queue: Phantom restarts often
// during deploys, and losing the queue on restart would throw away real
// learning signal. SQLite is the same store already used for sessions and
// scheduler jobs, so we are not adding a new persistence primitive.
//
// Zod validates the JSON columns on read. We never want `JSON.parse` to
// silently hand off an unexpected shape to the batch processor: the gate
// decision shape is load-bearing and a drift here would cause downstream
// crashes that look unrelated to the queue.

const GateSourceSchema = z.enum(["haiku", "failsafe"]);

const GateDecisionSchema: z.ZodType<GateDecision> = z.object({
	fire: z.boolean(),
	source: GateSourceSchema,
	reason: z.string(),
	haiku_cost_usd: z.number(),
});

const SessionSummarySchema: z.ZodType<SessionSummary> = z.object({
	session_id: z.string(),
	session_key: z.string(),
	user_id: z.string(),
	user_messages: z.array(z.string()),
	assistant_messages: z.array(z.string()),
	tools_used: z.array(z.string()),
	files_tracked: z.array(z.string()),
	outcome: z.enum(["success", "failure", "partial", "abandoned"]),
	cost_usd: z.number(),
	started_at: z.string(),
	ended_at: z.string(),
});

export type QueuedSession = {
	id: number;
	session_id: string;
	session_key: string;
	gate_decision: GateDecision;
	session_summary: SessionSummary;
	enqueued_at: string;
};

type QueueRow = {
	id: number;
	session_id: string;
	session_key: string;
	gate_decision_json: string;
	session_summary_json: string;
	enqueued_at: string;
};

export class EvolutionQueue {
	constructor(private db: Database) {}

	/**
	 * Insert one row per gate-approved session, latest summary wins for any
	 * given `session_key`. A busy multi-turn session that crosses the gate
	 * threshold more than once between drains would otherwise enqueue several
	 * stale rows for the same conversation, each of which would run the full
	 * judge pipeline against an older snapshot of the same dialog. Wrapping
	 * the delete and insert in a single transaction keeps the dedup atomic
	 * with respect to a concurrent `drainAll`.
	 */
	enqueue(summary: SessionSummary, decision: GateDecision): void {
		const tx = this.db.transaction(
			(sessionKey: string, sessionId: string, decisionJson: string, summaryJson: string) => {
				this.db.run("DELETE FROM evolution_queue WHERE session_key = ?", [sessionKey]);
				this.db.run(
					`INSERT INTO evolution_queue (session_id, session_key, gate_decision_json, session_summary_json)
				VALUES (?, ?, ?, ?)`,
					[sessionId, sessionKey, decisionJson, summaryJson],
				);
			},
		);
		tx(summary.session_key, summary.session_id, JSON.stringify(decision), JSON.stringify(summary));
	}

	depth(): number {
		const row = this.db.query("SELECT COUNT(*) AS c FROM evolution_queue").get() as { c: number } | null;
		return row?.c ?? 0;
	}

	/**
	 * Read every queued row ordered oldest-first. The cadence drains the
	 * entire queue in one batch rather than slicing: batch cost economics
	 * favour bundling, and the 180-minute cadence keeps the worst-case
	 * batch size bounded by the demand trigger.
	 */
	drainAll(): QueuedSession[] {
		const rows = this.db
			.query(
				"SELECT id, session_id, session_key, gate_decision_json, session_summary_json, enqueued_at FROM evolution_queue ORDER BY enqueued_at ASC, id ASC",
			)
			.all() as QueueRow[];
		return rows.map((row) => parseRow(row));
	}

	markProcessed(ids: number[]): void {
		if (ids.length === 0) return;
		// bun:sqlite parameter binding cannot expand arrays directly, so we
		// build a placeholder list once and pass the ids via spread. Deletion
		// is a single statement so we do not need a transaction.
		const placeholders = ids.map(() => "?").join(",");
		this.db.run(`DELETE FROM evolution_queue WHERE id IN (${placeholders})`, ids);
	}

	/** Test-only: truncate the queue between assertions. Not exposed to production callers. */
	clear(): void {
		this.db.run("DELETE FROM evolution_queue");
	}
}

function parseRow(row: QueueRow): QueuedSession {
	const decisionRaw: unknown = JSON.parse(row.gate_decision_json);
	const summaryRaw: unknown = JSON.parse(row.session_summary_json);
	const decision = GateDecisionSchema.parse(decisionRaw);
	const summary = SessionSummarySchema.parse(summaryRaw);
	return {
		id: row.id,
		session_id: row.session_id,
		session_key: row.session_key,
		gate_decision: decision,
		session_summary: summary,
		enqueued_at: row.enqueued_at,
	};
}
