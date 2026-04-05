import type { SlackBlock } from "../channels/feedback.ts";
import type { SlackChannel } from "../channels/slack.ts";
import type { LoopStore } from "./store.ts";
import type { Loop, LoopStatus } from "./types.ts";

const PROGRESS_BAR_CELLS = 10;

// Single source of truth for status → emoji. Bare names (no colons) because
// the Slack reactions.add/remove APIs take bare names; the status-message
// text wraps them with colons via `terminalEmoji()`. Keeping both formats
// derived from one map eliminates the silent drift risk when a new terminal
// status is added.
const TERMINAL_REACTION: Partial<Record<LoopStatus, string>> = {
	done: "white_check_mark",
	stopped: "octagonal_sign",
	budget_exceeded: "warning",
	failed: "x",
};

const REACTION_START = "hourglass_flowing_sand";
const REACTION_IN_FLIGHT = "arrows_counterclockwise";

const IN_FLIGHT_REACTIONS = [REACTION_START, REACTION_IN_FLIGHT] as const;

function terminalReaction(status: LoopStatus): string | null {
	return TERMINAL_REACTION[status] ?? null;
}

export function buildProgressBar(done: number, total: number): string {
	if (total <= 0) return `[${"░".repeat(PROGRESS_BAR_CELLS)}]`;
	const clamped = Math.max(0, Math.min(done, total));
	const filled = Math.round((clamped / total) * PROGRESS_BAR_CELLS);
	const empty = PROGRESS_BAR_CELLS - filled;
	return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}

export function terminalEmoji(status: LoopStatus): string {
	const reaction = TERMINAL_REACTION[status];
	if (reaction) return `:${reaction}:`;
	// Non-terminal statuses still need a glyph for the running-state text.
	return status === "running" ? ":repeat:" : ":grey_question:";
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Slack feedback for the loop lifecycle: start notice, per-tick progress
 * edit, final notice, and a reaction ladder on the operator's original
 * message (hourglass → cycle → terminal emoji).
 *
 * Extracted from LoopRunner because runner.ts was already at the 300-line
 * CONTRIBUTING.md cap and the progress-bar + reaction-ladder additions push
 * it over. All Slack-API failures are swallowed upstream in SlackChannel;
 * if a call-site here still throws, we catch and warn so loop execution is
 * never derailed by chat plumbing.
 *
 * Why not reuse createStatusReactionController: that controller debounces
 * per-tool-call runtime events via a promise-chain serializer. The loop
 * ladder has exactly three sequential lifecycle states (start, first tick,
 * terminal), no debouncing is required, and wiring it into the controller
 * would entangle two unrelated lifecycles. Plain best-effort
 * addReaction/removeReaction is the right choice here.
 */
export class LoopNotifier {
	constructor(
		private slackChannel: SlackChannel | null,
		private store: LoopStore,
	) {}

	async postStartNotice(loop: Loop): Promise<void> {
		if (!this.slackChannel || !loop.channelId) return;
		const text = `:repeat: Starting loop \`${loop.id.slice(0, 8)}\` (max ${loop.maxIterations} iter, $${loop.maxCostUsd.toFixed(2)} budget)\n> ${truncate(loop.goal, 200)}`;
		// When conversationId (a Slack thread ts) is set, thread the updates into it;
		// otherwise post a top-level message in the channel.
		const ts = await this.slackChannel.postToChannel(loop.channelId, text, loop.conversationId ?? undefined);
		if (!ts) return;
		this.store.setStatusMessageTs(loop.id, ts);

		// Attach a stop button so the operator can interrupt without using MCP.
		// Routed via setLoopStopHandler in slack-actions.ts.
		const blocks: SlackBlock[] = [
			{ type: "section", text: { type: "mrkdwn", text } },
			{
				type: "actions",
				block_id: `phantom_loop_actions_${loop.id}`,
				elements: [
					{
						type: "button",
						text: { type: "plain_text", text: "Stop loop", emoji: true },
						action_id: `phantom:loop_stop:${loop.id}`,
						style: "danger",
						value: loop.id,
					},
				],
			},
		];
		await this.slackChannel.updateMessage(loop.channelId, ts, text, blocks);

		if (loop.triggerMessageTs) {
			await this.slackChannel.addReaction(loop.channelId, loop.triggerMessageTs, REACTION_START);
		}
	}

	async postTickUpdate(id: string, iteration: number, status: string): Promise<void> {
		const loop = this.store.findById(id);
		if (!loop || !this.slackChannel || !loop.channelId || !loop.statusMessageTs) return;

		const bar = buildProgressBar(iteration, loop.maxIterations);
		const shortId = loop.id.slice(0, 8);
		const text = `:repeat: Loop \`${shortId}\` · ${bar} ${iteration}/${loop.maxIterations} · $${loop.totalCostUsd.toFixed(2)}/$${loop.maxCostUsd.toFixed(2)} · ${status}`;
		await this.slackChannel.updateMessage(loop.channelId, loop.statusMessageTs, text);

		// On the first tick, swap hourglass → cycling arrows. Restart-safe by
		// construction: iteration is sourced from the call site, so on resume
		// the swap only fires if the loop is actually transitioning through
		// iteration 1, no in-memory flag to repopulate.
		if (iteration === 1 && loop.triggerMessageTs) {
			await this.slackChannel.removeReaction(loop.channelId, loop.triggerMessageTs, REACTION_START);
			await this.slackChannel.addReaction(loop.channelId, loop.triggerMessageTs, REACTION_IN_FLIGHT);
		}
	}

	async postFinalNotice(loop: Loop, status: LoopStatus): Promise<void> {
		if (!this.slackChannel || !loop.channelId) return;
		const emoji = terminalEmoji(status);
		const text = `${emoji} Loop \`${loop.id.slice(0, 8)}\` finished (${status}) after ${loop.iterationCount} iterations, $${loop.totalCostUsd.toFixed(4)} spent`;
		if (loop.statusMessageTs) {
			await this.slackChannel.updateMessage(loop.channelId, loop.statusMessageTs, text);
		} else {
			await this.slackChannel.postToChannel(loop.channelId, text);
		}

		if (loop.triggerMessageTs) {
			// Best-effort: clear whichever in-flight reaction is currently on
			// the message (removeReaction is idempotent on missing), then stamp
			// the terminal one.
			for (const reaction of IN_FLIGHT_REACTIONS) {
				await this.slackChannel.removeReaction(loop.channelId, loop.triggerMessageTs, reaction);
			}
			const terminal = terminalReaction(status);
			if (terminal) {
				await this.slackChannel.addReaction(loop.channelId, loop.triggerMessageTs, terminal);
			}
		}
	}
}
