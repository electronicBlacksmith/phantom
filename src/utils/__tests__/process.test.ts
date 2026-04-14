import { describe, expect, test } from "bun:test";
import { type ProcessLimits, drainProcessWithLimits, readStreamWithCap } from "../process.ts";

describe("readStreamWithCap", () => {
	test("reads full stream when under cap", async () => {
		const data = "hello world";
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(data));
				controller.close();
			},
		});

		const result = await readStreamWithCap(stream, 1000);
		expect(result.text).toBe(data);
		expect(result.truncated).toBe(false);
	});

	test("truncates output at maxBytes", async () => {
		const data = "a".repeat(100);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(data));
				controller.close();
			},
		});

		const result = await readStreamWithCap(stream, 50);
		expect(result.text).toContain("a".repeat(50));
		expect(result.text).toContain("_(Output truncated at 50 bytes.)_");
		expect(result.truncated).toBe(true);
	});

	test("handles multiple chunks", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("chunk1"));
				controller.enqueue(new TextEncoder().encode("chunk2"));
				controller.enqueue(new TextEncoder().encode("chunk3"));
				controller.close();
			},
		});

		const result = await readStreamWithCap(stream, 1000);
		expect(result.text).toBe("chunk1chunk2chunk3");
		expect(result.truncated).toBe(false);
	});
});

describe("drainProcessWithLimits", () => {
	test("drains stdout and stderr concurrently without deadlock", async () => {
		// Write large output to both stdout and stderr simultaneously
		// This would deadlock with sequential reads if stderr buffer fills
		const script = `
			for i in {1..100}; do
				echo "stdout line $i"
				echo "stderr line $i" >&2
			done
		`;

		const proc = Bun.spawn(["bash", "-c", script], {
			stdout: "pipe",
			stderr: "pipe",
		});

		const limits: ProcessLimits = { timeoutMs: 5000, maxOutputBytes: 100_000 };
		const result = await drainProcessWithLimits(proc, limits);

		expect(result.timedOut).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("stdout line 1");
		expect(result.stdout).toContain("stdout line 100");
		expect(result.stderr).toContain("stderr line 1");
		expect(result.stderr).toContain("stderr line 100");
	});

	test("times out long-running process", async () => {
		const proc = Bun.spawn(["bash", "-c", "sleep 10"], {
			stdout: "pipe",
			stderr: "pipe",
		});

		const limits: ProcessLimits = { timeoutMs: 100, maxOutputBytes: 1000 };
		const result = await drainProcessWithLimits(proc, limits);

		expect(result.timedOut).toBe(true);
	});

	test("truncates large stdout at maxOutputBytes", async () => {
		// Generate 10KB of output
		const proc = Bun.spawn(["bash", "-c", "yes | head -c 10000"], {
			stdout: "pipe",
			stderr: "pipe",
		});

		const limits: ProcessLimits = { timeoutMs: 5000, maxOutputBytes: 1000 };
		const result = await drainProcessWithLimits(proc, limits);

		expect(result.timedOut).toBe(false);
		expect(result.stdout.length).toBeLessThan(1200); // 1000 + truncation message
		expect(result.stdout).toContain("_(Output truncated at 1000 bytes.)_");
	});

	test("captures exit code", async () => {
		const proc = Bun.spawn(["bash", "-c", "exit 42"], {
			stdout: "pipe",
			stderr: "pipe",
		});

		const limits: ProcessLimits = { timeoutMs: 5000, maxOutputBytes: 1000 };
		const result = await drainProcessWithLimits(proc, limits);

		expect(result.exitCode).toBe(42);
		expect(result.timedOut).toBe(false);
	});
});
