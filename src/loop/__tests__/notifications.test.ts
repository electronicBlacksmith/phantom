import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SlackChannel } from "../../channels/slack.ts";
import { runMigrations } from "../../db/migrate.ts";
import { LoopNotifier, buildProgressBar, terminalEmoji } from "../notifications.ts";
import { LoopStore } from "../store.ts";
import type { Loop, LoopStatus } from "../types.ts";

// Minimal SlackChannel shape the notifier actually calls. Every method is
// a mock so we can assert call args and ordering.
type MockSlack = {
	postToChannel: ReturnType<typeof mock>;
	updateMessage: ReturnType<typeof mock>;
	addReaction: ReturnType<typeof mock>;
	removeReaction: ReturnType<typeof mock>;
};

function makeSlack(overrides: Partial<MockSlack> = {}): MockSlack {
	return {
		postToChannel: mock(async () => "1700000000.100100"),
		updateMessage: mock(async () => undefined),
		addReaction: mock(async () => undefined),
		removeReaction: mock(async () => undefined),
		...overrides,
	};
}

function asSlack(m: MockSlack): SlackChannel {
	return m as unknown as SlackChannel;
}

function makeLoop(overrides: Partial<Loop> = {}): Loop {
	return {
		id: "abcdef0123456789",
		goal: "test goal",
		workspaceDir: "/tmp/ws",
		stateFile: "/tmp/ws/state.md",
		successCommand: null,
		maxIterations: 10,
		maxCostUsd: 5,
		status: "running",
		iterationCount: 0,
		totalCostUsd: 0,
		channelId: "C100",
		conversationId: "1700000000.000100",
		statusMessageTs: null,
		triggerMessageTs: "1700000000.000200",
		interruptRequested: false,
		lastError: null,
		startedAt: "2026-04-05T00:00:00Z",
		lastTickAt: null,
		finishedAt: null,
		...overrides,
	};
}

describe("buildProgressBar", () => {
	test("renders empty bar at 0/N", () => {
		expect(buildProgressBar(0, 10)).toBe("[░░░░░░░░░░]");
	});
	test("renders full bar at N/N", () => {
		expect(buildProgressBar(10, 10)).toBe("[██████████]");
	});
	test("renders half bar at N/2", () => {
		expect(buildProgressBar(5, 10)).toBe("[█████░░░░░]");
	});
	test("rounds to nearest cell", () => {
		// 3/7 ≈ 43% → 4 cells of 10
		expect(buildProgressBar(3, 7)).toBe("[████░░░░░░]");
	});
	test("clamps overflow", () => {
		expect(buildProgressBar(99, 10)).toBe("[██████████]");
	});
	test("handles zero total safely", () => {
		expect(buildProgressBar(0, 0)).toBe("[░░░░░░░░░░]");
	});
});

describe("terminalEmoji", () => {
	test("maps every known status", () => {
		expect(terminalEmoji("done")).toBe(":white_check_mark:");
		expect(terminalEmoji("stopped")).toBe(":octagonal_sign:");
		expect(terminalEmoji("budget_exceeded")).toBe(":warning:");
		expect(terminalEmoji("failed")).toBe(":x:");
		expect(terminalEmoji("running")).toBe(":repeat:");
	});
});

describe("LoopNotifier", () => {
	let db: Database;
	let store: LoopStore;

	beforeEach(() => {
		db = new Database(":memory:");
		db.run("PRAGMA journal_mode = WAL");
		runMigrations(db);
		store = new LoopStore(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("postStartNotice", () => {
		test("no-ops when slackChannel is null", async () => {
			const notifier = new LoopNotifier(null, store);
			await notifier.postStartNotice(makeLoop());
			// Nothing to assert beyond "did not throw"; the null guard is the
			// whole point.
			expect(true).toBe(true);
		});

		test("no-ops when loop.channelId is null", async () => {
			const slack = makeSlack();
			const notifier = new LoopNotifier(asSlack(slack), store);
			await notifier.postStartNotice(makeLoop({ channelId: null }));
			expect(slack.postToChannel).not.toHaveBeenCalled();
			expect(slack.addReaction).not.toHaveBeenCalled();
		});

		test("posts, persists ts, attaches stop button, stamps start reaction", async () => {
			// Insert a real row so setStatusMessageTs can UPDATE it.
			const loop = store.insert({
				id: "abcdef0123456789",
				goal: "g",
				workspaceDir: "/tmp/ws",
				stateFile: "/tmp/ws/state.md",
				successCommand: null,
				maxIterations: 10,
				maxCostUsd: 5,
				channelId: "C100",
				conversationId: "1700000000.000100",
				triggerMessageTs: "1700000000.000200",
			});

			const slack = makeSlack();
			const notifier = new LoopNotifier(asSlack(slack), store);
			await notifier.postStartNotice(loop);

			expect(slack.postToChannel).toHaveBeenCalledTimes(1);
			const [channel, text, threadTs] = slack.postToChannel.mock.calls[0];
			expect(channel).toBe("C100");
			expect(text).toContain("Starting loop");
			expect(threadTs).toBe("1700000000.000100");

			// Stop button attached via updateMessage with blocks
			expect(slack.updateMessage).toHaveBeenCalledTimes(1);
			const updateArgs = slack.updateMessage.mock.calls[0];
			expect(updateArgs[0]).toBe("C100");
			expect(updateArgs[3]).toBeDefined(); // blocks array
			const blocks = updateArgs[3] as Array<Record<string, unknown>>;
			const actionsBlock = blocks.find((b) => b.type === "actions");
			expect(actionsBlock).toBeDefined();

			// Reaction stamped on the operator's trigger message
			expect(slack.addReaction).toHaveBeenCalledWith("C100", "1700000000.000200", "hourglass_flowing_sand");

			// Persisted status_message_ts round-trips back through findById
			const reloaded = store.findById(loop.id);
			expect(reloaded?.statusMessageTs).toBe("1700000000.100100");
		});

		test("skips reaction when triggerMessageTs is null", async () => {
			const loop = store.insert({
				id: "abcdef0123456789",
				goal: "g",
				workspaceDir: "/tmp/ws",
				stateFile: "/tmp/ws/state.md",
				successCommand: null,
				maxIterations: 10,
				maxCostUsd: 5,
				channelId: "C100",
				conversationId: null,
				triggerMessageTs: null,
			});
			const slack = makeSlack();
			const notifier = new LoopNotifier(asSlack(slack), store);
			await notifier.postStartNotice(loop);
			expect(slack.postToChannel).toHaveBeenCalled();
			expect(slack.addReaction).not.toHaveBeenCalled();
		});
	});

	describe("postTickUpdate", () => {
		function insertWithStatusTs(overrides: { triggerMessageTs?: string | null; iteration?: number } = {}) {
			const row = store.insert({
				id: "abcdef0123456789",
				goal: "g",
				workspaceDir: "/tmp/ws",
				stateFile: "/tmp/ws/state.md",
				successCommand: null,
				maxIterations: 10,
				maxCostUsd: 5,
				channelId: "C100",
				conversationId: "1700000000.000100",
				triggerMessageTs: overrides.triggerMessageTs ?? "1700000000.000200",
			});
			store.setStatusMessageTs(row.id, "1700000000.100100");
			if (overrides.iteration) store.recordTick(row.id, overrides.iteration, 0);
			const reloaded = store.findById(row.id);
			if (!reloaded) throw new Error("failed to reload");
			return reloaded;
		}

		test("edits the status message with a progress bar and cost", async () => {
			const loop = insertWithStatusTs();
			const slack = makeSlack();
			const notifier = new LoopNotifier(asSlack(slack), store);
			await notifier.postTickUpdate(loop.id, 3, "in-progress");

			expect(slack.updateMessage).toHaveBeenCalledTimes(1);
			const [ch, ts, text] = slack.updateMessage.mock.calls[0];
			expect(ch).toBe("C100");
			expect(ts).toBe("1700000000.100100");
			expect(text).toContain("3/10");
			expect(text).toContain("abcdef01");
			expect(text).toMatch(/\[█+░+\]/);
			expect(text).toContain("in-progress");
		});

		test("swaps hourglass → cycle on the first tick", async () => {
			insertWithStatusTs();
			const slack = makeSlack();
			const notifier = new LoopNotifier(asSlack(slack), store);
			await notifier.postTickUpdate("abcdef0123456789", 1, "in-progress");

			expect(slack.removeReaction).toHaveBeenCalledWith("C100", "1700000000.000200", "hourglass_flowing_sand");
			expect(slack.addReaction).toHaveBeenCalledWith("C100", "1700000000.000200", "arrows_counterclockwise");
		});

		test("does not swap reactions on tick 2+", async () => {
			insertWithStatusTs();
			const slack = makeSlack();
			const notifier = new LoopNotifier(asSlack(slack), store);
			await notifier.postTickUpdate("abcdef0123456789", 2, "in-progress");

			expect(slack.removeReaction).not.toHaveBeenCalled();
			expect(slack.addReaction).not.toHaveBeenCalled();
		});

		test("no-ops when statusMessageTs is not yet set", async () => {
			store.insert({
				id: "abcdef0123456789",
				goal: "g",
				workspaceDir: "/tmp/ws",
				stateFile: "/tmp/ws/state.md",
				successCommand: null,
				maxIterations: 10,
				maxCostUsd: 5,
				channelId: "C100",
				conversationId: null,
				triggerMessageTs: "1700000000.000200",
			});
			const slack = makeSlack();
			const notifier = new LoopNotifier(asSlack(slack), store);
			await notifier.postTickUpdate("abcdef0123456789", 1, "in-progress");
			expect(slack.updateMessage).not.toHaveBeenCalled();
		});
	});

	describe("postFinalNotice", () => {
		const cases: Array<{ status: LoopStatus; reaction: string }> = [
			{ status: "done", reaction: "white_check_mark" },
			{ status: "stopped", reaction: "octagonal_sign" },
			{ status: "budget_exceeded", reaction: "warning" },
			{ status: "failed", reaction: "x" },
		];

		for (const { status, reaction } of cases) {
			test(`stamps terminal reaction for status=${status}`, async () => {
				const slack = makeSlack();
				const notifier = new LoopNotifier(asSlack(slack), store);
				await notifier.postFinalNotice(makeLoop({ statusMessageTs: "1700000000.100100", status }), status);
				const addCalls = slack.addReaction.mock.calls.map((c: unknown[]) => c[2]);
				expect(addCalls).toContain(reaction);
				// Both in-flight reactions best-effort removed
				const removeCalls = slack.removeReaction.mock.calls.map((c: unknown[]) => c[2]);
				expect(removeCalls).toContain("hourglass_flowing_sand");
				expect(removeCalls).toContain("arrows_counterclockwise");
			});
		}

		test("edits existing status message when set", async () => {
			const slack = makeSlack();
			const notifier = new LoopNotifier(asSlack(slack), store);
			await notifier.postFinalNotice(makeLoop({ statusMessageTs: "1700000000.100100" }), "done");
			expect(slack.updateMessage).toHaveBeenCalledTimes(1);
			expect(slack.postToChannel).not.toHaveBeenCalled();
		});

		test("posts new message when statusMessageTs is null", async () => {
			const slack = makeSlack();
			const notifier = new LoopNotifier(asSlack(slack), store);
			await notifier.postFinalNotice(makeLoop({ statusMessageTs: null }), "done");
			expect(slack.postToChannel).toHaveBeenCalledTimes(1);
			expect(slack.updateMessage).not.toHaveBeenCalled();
		});

		test("no-ops when triggerMessageTs is null", async () => {
			const slack = makeSlack();
			const notifier = new LoopNotifier(asSlack(slack), store);
			await notifier.postFinalNotice(
				makeLoop({ statusMessageTs: "1700000000.100100", triggerMessageTs: null }),
				"done",
			);
			expect(slack.addReaction).not.toHaveBeenCalled();
			expect(slack.removeReaction).not.toHaveBeenCalled();
		});
	});
});
