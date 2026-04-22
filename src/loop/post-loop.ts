import type { EvolutionEngine } from "../evolution/engine.ts";
import type { SessionSummary } from "../evolution/types.ts";
import type { SessionData } from "../memory/consolidation.ts";
import type { MemorySystem } from "../memory/system.ts";
import type { Loop, LoopStatus } from "./types.ts";

// Local SessionData -> SessionSummary adapter. v0.20.2 removed the shared
// sessionDataToSummary helper from memory/consolidation.ts; the reflection
// subprocess now owns summarization. This thin mapper keeps the loop's
// evolution hook working.
function summarizeSessionForEvolution(data: SessionData): SessionSummary {
	return {
		session_id: data.sessionId,
		session_key: data.sessionKey,
		user_id: data.userId,
		user_messages: data.userMessages,
		assistant_messages: data.assistantMessages,
		tools_used: data.toolsUsed,
		files_tracked: data.filesTracked,
		outcome: data.outcome,
		cost_usd: data.costUsd,
		started_at: data.startedAt,
		ended_at: data.endedAt,
	};
}

export type LoopTranscript = {
	firstPrompt: string;
	firstResponse: string;
	summaries: string[];
	lastPrompt: string;
	lastResponse: string;
};

export type PostLoopDeps = {
	evolution?: EvolutionEngine;
	memory?: MemorySystem;
	/** Callback to update runtime's evolved config after evolution applies changes. */
	onEvolvedConfigUpdate?: (config: ReturnType<EvolutionEngine["getConfig"]>) => void;
};

function loopStatusToOutcome(status: LoopStatus): SessionData["outcome"] {
	switch (status) {
		case "done":
			return "success";
		case "stopped":
			return "abandoned";
		default:
			return "failure";
	}
}

const MAX_ROLLING_SUMMARIES = 10;

export function recordTranscript(
	transcripts: Map<string, LoopTranscript>,
	loopId: string,
	iteration: number,
	prompt: string,
	response: string,
	stateStatus: string | undefined,
): void {
	let transcript = transcripts.get(loopId);
	if (!transcript) {
		transcript = {
			firstPrompt: prompt,
			firstResponse: response,
			summaries: [],
			lastPrompt: prompt,
			lastResponse: response,
		};
		transcripts.set(loopId, transcript);
	} else {
		transcript.lastPrompt = prompt;
		transcript.lastResponse = response;
	}
	const summary = `Tick ${iteration}: ${stateStatus ?? "in-progress"}`;
	transcript.summaries.push(summary);
	if (transcript.summaries.length > MAX_ROLLING_SUMMARIES) transcript.summaries.shift();
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

export function synthesizeSessionData(loop: Loop, status: LoopStatus, transcript: LoopTranscript): SessionData {
	const outcome = loopStatusToOutcome(status);
	const header = `[Loop: ${loop.iterationCount} ticks, goal: ${loop.goal.slice(0, 200)}, outcome: ${outcome}]`;

	const userMessages = [
		`${header} Tick 1: ${transcript.firstPrompt.slice(0, 500)}`,
		...transcript.summaries,
		`Final tick: ${transcript.lastPrompt.slice(0, 500)}`,
	];

	const assistantMessages = [transcript.firstResponse.slice(0, 1000), transcript.lastResponse.slice(0, 1000)];

	// userId sentinel: channel-originated loops use channel ID, headless use "autonomous"
	const userId = loop.channelId ? `channel:${loop.channelId}` : "autonomous";

	return {
		sessionId: loop.id,
		sessionKey: loop.channelId && loop.conversationId ? `${loop.channelId}:${loop.conversationId}` : `loop:${loop.id}`,
		userId,
		userMessages,
		assistantMessages,
		toolsUsed: [],
		filesTracked: [],
		startedAt: loop.startedAt,
		endedAt: loop.finishedAt ?? new Date().toISOString(),
		costUsd: loop.totalCostUsd,
		outcome,
	};
}

/**
 * Run evolution and memory consolidation after a loop finishes.
 * Fire-and-forget from the runner's perspective - errors are logged,
 * never propagated to affect loop status.
 */
export async function runPostLoopPipeline(deps: PostLoopDeps, sessionData: SessionData): Promise<void> {
	const { evolution, memory, onEvolvedConfigUpdate } = deps;
	const { consolidateSession } = await import("../memory/consolidation.ts");

	// Evolution pipeline - runs independently of memory state.
	// v0.20.2 moved session summarization into the reflection subprocess,
	// so we pass the raw SessionData-derived summary directly. The LLM-driven
	// consolidation path (consolidateSessionWithLLM) was removed upstream and
	// its work is now absorbed by the reflection subprocess.
	if (evolution) {
		const summary = summarizeSessionForEvolution(sessionData);
		try {
			const result = await evolution.afterSession(summary);
			if (result.changes_applied.length > 0 && onEvolvedConfigUpdate) {
				onEvolvedConfigUpdate(evolution.getConfig());
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[loop] Post-loop evolution failed: ${msg}`);
		}
	}

	// Memory consolidation - runs independently of evolution state.
	// Heuristic path only; upstream removed the LLM consolidation path.
	if (!memory?.isReady()) return;
	try {
		const result = await consolidateSession(memory, sessionData);
		if (result.episodesCreated > 0 || result.factsExtracted > 0) {
			console.log(
				`[loop] Consolidated: ${result.episodesCreated} episodes, ${result.factsExtracted} facts (${result.durationMs}ms)`,
			);
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[loop] Post-loop memory consolidation failed: ${msg}`);
	}
}
