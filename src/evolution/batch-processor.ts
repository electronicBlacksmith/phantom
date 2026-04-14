import type { EvolutionEngine } from "./engine.ts";
import type { QueuedSession } from "./queue.ts";
import type { EvolutionResult } from "./types.ts";

// Phase 2 batch processor. This is a DELIBERATE TEMPORARY SEAM between the
// cadence drain path and the existing 6-judge pipeline. Phase 3 will replace
// the body of `processBatch` with a single reflection subprocess that reads
// the whole batch and writes memory files directly. The Phase 2 body is
// intentionally minimal so that replacement is as clean as possible:
//
// - No strategy pattern.
// - No configuration knobs.
// - No abstractions that assume the Phase 3 shape.
// - A thin wrapper that iterates the batch and calls the existing pipeline.
//
// If you find yourself adding indirection here, stop. The next builder agent
// will delete the body of this function entirely.

export type SessionBatchEntry =
	| { id: number; ok: true; result: EvolutionResult }
	| { id: number; ok: false; error: string };

export type BatchResult = {
	processed: number;
	successCount: number;
	failureCount: number;
	results: SessionBatchEntry[];
	durationMs: number;
};

/**
 * Drain the queue rows and run the existing evolution pipeline per session.
 * Phase 0's mutex guards the engine so the cadence caller is responsible for
 * serialising batches; `processBatch` itself does not acquire the mutex.
 *
 * Partial failures continue through the batch: if the pipeline throws on one
 * session, we record the error and move to the next row. Phase 0's
 * `CycleAborted` catch inside `engine.afterSession` means each session's
 * failure mode is already bounded.
 */
export async function processBatch(queuedSessions: QueuedSession[], engine: EvolutionEngine): Promise<BatchResult> {
	const startedAt = Date.now();
	const results: SessionBatchEntry[] = [];
	let successCount = 0;
	let failureCount = 0;

	for (const queued of queuedSessions) {
		try {
			const result = await engine.runSingleSessionPipeline(queued.session_summary);
			results.push({ id: queued.id, ok: true, result });
			successCount += 1;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			results.push({ id: queued.id, ok: false, error: msg });
			failureCount += 1;
		}
	}

	return {
		processed: results.length,
		successCount,
		failureCount,
		results,
		durationMs: Date.now() - startedAt,
	};
}
