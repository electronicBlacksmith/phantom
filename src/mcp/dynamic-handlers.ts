import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ProcessLimits, drainProcessWithLimits } from "../utils/process.ts";
import type { DynamicToolDef } from "./dynamic-tools.ts";

const DEFAULT_HANDLER_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

function getHandlerLimits(): ProcessLimits {
	return {
		timeoutMs: Number(process.env.PHANTOM_DYNAMIC_HANDLER_TIMEOUT_MS ?? DEFAULT_HANDLER_TIMEOUT_MS),
		maxOutputBytes: Number(process.env.PHANTOM_DYNAMIC_HANDLER_MAX_OUTPUT_BYTES ?? DEFAULT_MAX_OUTPUT_BYTES),
	};
}

/**
 * Safe environment for subprocess execution.
 * Only expose what dynamic tools legitimately need.
 * Secrets (API keys, tokens) are never passed to subprocesses.
 *
 * @param input - Tool input to serialize as TOOL_INPUT env var
 * @param explicitEnv - Optional explicit env vars to include (e.g., GH_TOKEN for phantom_gh_exec)
 */
export function buildSafeEnv(
	input: Record<string, unknown>,
	explicitEnv?: Record<string, string>,
): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		HOME: process.env.HOME ?? "/tmp",
		LANG: process.env.LANG ?? "en_US.UTF-8",
		TERM: process.env.TERM ?? "xterm-256color",
		TOOL_INPUT: JSON.stringify(input),
		...explicitEnv,
	};
}

function timeoutResult(toolName: string, timeoutMs: number, partial: string): CallToolResult {
	const snippet = partial.slice(0, 500);
	return {
		content: [
			{
				type: "text",
				text: `Tool '${toolName}' timed out after ${timeoutMs}ms and was killed. Partial output: ${snippet}`,
			},
		],
		isError: true,
	};
}

export async function executeDynamicHandler(
	tool: DynamicToolDef,
	input: Record<string, unknown>,
): Promise<CallToolResult> {
	try {
		switch (tool.handlerType) {
			case "script":
				return executeScriptHandler(tool, input);
			case "shell":
				return executeShellHandler(tool, input);
			default:
				return {
					content: [
						{
							type: "text",
							text: `Unknown handler type: ${tool.handlerType}. Only "script" and "shell" are supported.`,
						},
					],
					isError: true,
				};
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			content: [{ type: "text", text: `Error executing tool '${tool.name}': ${msg}` }],
			isError: true,
		};
	}
}

async function executeScriptHandler(tool: DynamicToolDef, input: Record<string, unknown>): Promise<CallToolResult> {
	const path = tool.handlerPath ?? "";
	const { existsSync } = await import("node:fs");
	if (!existsSync(path)) {
		return {
			content: [{ type: "text", text: `Script not found: ${path}` }],
			isError: true,
		};
	}

	const limits = getHandlerLimits();

	// --env-file= prevents bun from auto-loading .env/.env.local files,
	// which would leak secrets into the subprocess despite buildSafeEnv.
	const proc = Bun.spawn(["bun", "--env-file=", "run", path], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: buildSafeEnv(input),
	});

	proc.stdin.write(JSON.stringify(input));
	proc.stdin.end();

	const { stdout, stderr, exitCode, timedOut } = await drainProcessWithLimits(proc, limits);

	if (timedOut) {
		return timeoutResult(tool.name, limits.timeoutMs, stderr || stdout);
	}

	if (exitCode !== 0) {
		return {
			content: [{ type: "text", text: `Script error (exit ${exitCode}): ${stderr || stdout}` }],
			isError: true,
		};
	}

	return { content: [{ type: "text", text: stdout.trim() }] };
}

async function executeShellHandler(tool: DynamicToolDef, input: Record<string, unknown>): Promise<CallToolResult> {
	const command = tool.handlerCode ?? "";
	const limits = getHandlerLimits();

	const proc = Bun.spawn(["bash", "-c", command], {
		stdout: "pipe",
		stderr: "pipe",
		env: buildSafeEnv(input),
	});

	const { stdout, stderr, exitCode, timedOut } = await drainProcessWithLimits(proc, limits);

	if (timedOut) {
		return timeoutResult(tool.name, limits.timeoutMs, stderr || stdout);
	}

	if (exitCode !== 0) {
		return {
			content: [{ type: "text", text: `Shell error (exit ${exitCode}): ${stderr || stdout}` }],
			isError: true,
		};
	}

	return { content: [{ type: "text", text: stdout.trim() }] };
}
