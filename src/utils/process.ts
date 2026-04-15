import type { Subprocess } from "bun";

/** Grace period after SIGTERM before escalating to SIGKILL */
export const HANDLER_GRACE_MS = 2_000;

export type ProcessLimits = {
	timeoutMs: number;
	maxOutputBytes: number;
};

export type DrainResult = {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
};

/**
 * Drain a ReadableStream with a hard byte cap.
 *
 * Critically, we keep reading (and dropping) chunks past the cap so the child
 * process never blocks on a full 64 KB pipe buffer. Cancelling the reader would
 * be simpler but risks leaving the child stuck on its next write.
 */
export async function readStreamWithCap(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	let truncated = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (truncated) continue;
			if (totalBytes + value.byteLength > maxBytes) {
				const remaining = maxBytes - totalBytes;
				if (remaining > 0) chunks.push(value.subarray(0, remaining));
				totalBytes = maxBytes;
				truncated = true;
			} else {
				chunks.push(value);
				totalBytes += value.byteLength;
			}
		}
	} finally {
		reader.releaseLock();
	}

	const combined = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const text = new TextDecoder().decode(combined);
	return {
		text: truncated ? `${text}\n\n_(Output truncated at ${maxBytes} bytes.)_` : text,
		truncated,
	};
}

/**
 * Run a spawned subprocess with concurrent pipe drains, a hard timeout, and
 * stdout/stderr size caps. Concurrent drains prevent the classic sequential
 * drain deadlock (child blocks on stderr write while parent waits for stdout
 * EOF). Timeout fires SIGTERM, escalates to SIGKILL after a grace period.
 */
export async function drainProcessWithLimits(
	proc: Subprocess<"pipe" | "ignore" | "inherit", "pipe", "pipe">,
	limits: ProcessLimits,
): Promise<DrainResult> {
	let timedOut = false;
	const termTimer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGTERM");
	}, limits.timeoutMs);
	const killTimer = setTimeout(() => {
		proc.kill("SIGKILL");
	}, limits.timeoutMs + HANDLER_GRACE_MS);

	try {
		const [stdoutResult, stderrResult] = await Promise.all([
			readStreamWithCap(proc.stdout, limits.maxOutputBytes),
			readStreamWithCap(proc.stderr, limits.maxOutputBytes),
		]);
		await proc.exited;
		return {
			stdout: stdoutResult.text,
			stderr: stderrResult.text,
			exitCode: proc.exitCode,
			timedOut,
		};
	} finally {
		clearTimeout(termTimer);
		clearTimeout(killTimer);
	}
}
