// Sonnet describe-your-job assist.
//
// CARDINAL RULE: This endpoint helps the OPERATOR fill a form. The operator
// reviews and edits the structured output before saving. It does NOT classify
// user intent, and it does NOT drive the agent at run time. When the job
// fires, the agent gets the operator's final `task` prompt and decides what
// to do with it. Sonnet here is form plumbing, not a routing layer.
//
// A tiny one-shot Messages API call with forced tool-use is the simplest
// shape that produces validated structured output. We do not use the Agent
// SDK for this: a raw Messages call avoids the subprocess overhead and the
// full tool surface we do not need.

import Anthropic from "@anthropic-ai/sdk";
import { JobCreateInputSchema, type JobCreateInputParsed } from "./tool-schema.ts";

type AnthropicClient = InstanceType<typeof Anthropic>;

export type ParseSuccess = {
	ok: true;
	proposal: JobCreateInputParsed;
	warnings: string[];
};

export type ParseFailure = {
	ok: false;
	status: 422 | 503 | 504;
	error: string;
};

export type ParseResult = ParseSuccess | ParseFailure;

export type ParseDeps = {
	apiKey?: string | null;
	clientFactory?: (apiKey: string) => AnthropicClient;
	timeoutMs?: number;
	model?: string;
};

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_TIMEOUT_MS = 15_000;

// JSON Schema matching JobCreateInputSchema in tool-schema.ts. Hand-written
// because the repo does not pull zod-to-json-schema; keeping it local avoids
// adding a dependency for a ~40-line conversion. The Zod parse on the server
// is the source of truth; this schema is advisory for Sonnet.
const PROPOSE_JOB_INPUT_SCHEMA: {
	type: "object";
	properties: Record<string, unknown>;
	required: string[];
	additionalProperties: boolean;
} = {
	type: "object",
	properties: {
		name: {
			type: "string",
			minLength: 1,
			maxLength: 200,
			description: "Short, kebab-case-ish job name, 1..200 chars (e.g. hn-digest, pr-review-reminder).",
		},
		description: {
			type: "string",
			maxLength: 1000,
			description: "One-sentence human summary of what this job does.",
		},
		schedule: {
			oneOf: [
				{
					type: "object",
					properties: {
						kind: { const: "at" },
						at: {
							type: "string",
							description: "ISO 8601 with explicit offset (e.g. 2026-04-18T15:00:00-07:00).",
						},
					},
					required: ["kind", "at"],
					additionalProperties: false,
				},
				{
					type: "object",
					properties: {
						kind: { const: "every" },
						intervalMs: {
							type: "integer",
							minimum: 1,
							description: "Interval in milliseconds. 6 hours = 21600000.",
						},
					},
					required: ["kind", "intervalMs"],
					additionalProperties: false,
				},
				{
					type: "object",
					properties: {
						kind: { const: "cron" },
						expr: {
							type: "string",
							description: "5-field cron: minute hour day-of-month month day-of-week. No nicknames.",
						},
						tz: { type: "string", description: "IANA timezone name." },
					},
					required: ["kind", "expr"],
					additionalProperties: false,
				},
			],
		},
		task: {
			type: "string",
			minLength: 1,
			maxLength: 32 * 1024,
			description:
				"Self-contained instruction for the agent to execute when the job fires. Include every piece of context the run will need.",
		},
		delivery: {
			type: "object",
			properties: {
				channel: { enum: ["slack", "none"] },
				target: {
					type: "string",
					description: '"owner" for owner DM, or a Slack channel id (C...) or user id (U...).',
				},
			},
			additionalProperties: false,
		},
		deleteAfterRun: { type: "boolean" },
	},
	required: ["name", "schedule", "task"],
	additionalProperties: false,
};

const SYSTEM_PROMPT = [
	"You are helping an operator author a scheduled job for an autonomous AI agent.",
	"Convert the operator's plain-English description into a structured job proposal.",
	"",
	"Fields:",
	"- name: kebab-case short label (hn-digest, pr-review-reminder, daily-standup).",
	'- description: one sentence summary.',
	"- task: self-contained instruction the agent will execute when the job fires.",
	"  The agent will not have the current conversation context. Include every URL,",
	"  repo name, channel, or constraint the run needs. Write imperative, concrete.",
	"- schedule: one of",
	'  { "kind": "at", "at": "<ISO 8601 with offset>" } for one-shot runs,',
	'  { "kind": "every", "intervalMs": <ms> } for simple intervals,',
	'  { "kind": "cron", "expr": "<5-field cron>", "tz": "<IANA tz>" } for calendar patterns.',
	"- delivery: default { channel: 'slack', target: 'owner' } unless the operator specified a Slack channel id (C...) or user id (U...).",
	"",
	"Heuristics:",
	"- 'every 6 hours' -> every, intervalMs 21600000.",
	"- 'every 30 minutes' -> every, intervalMs 1800000.",
	"- '9am weekdays' / 'weekday mornings' -> cron, '0 9 * * 1-5', tz America/Los_Angeles.",
	"- '9am daily' -> cron, '0 9 * * *', tz America/Los_Angeles.",
	"- 'Friday 5pm' -> cron, '0 17 * * 5', tz America/Los_Angeles.",
	"- 'tomorrow at 3pm' or a specific date -> at with ISO 8601 and an explicit offset.",
	"- Default timezone America/Los_Angeles when the operator did not specify one.",
	"",
	"Always call the `propose_job` tool exactly once with a valid argument object.",
	"If the description is incoherent or you cannot infer a schedule, still call the",
	"tool with your best-effort values and set `task` to an empty string so the",
	"operator fills it in manually.",
].join("\n");

function defaultClientFactory(apiKey: string): AnthropicClient {
	return new Anthropic({ apiKey });
}

function extractErrorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

/**
 * Call Sonnet with a forced tool-use schema and return a structured proposal
 * the operator can review before saving. Does not mutate any state; the
 * actual job creation happens only when the operator hits Save in the UI.
 *
 * The caller is responsible for length-validating `description` before
 * invoking this function. On any failure we return a typed error so the
 * UI can surface it inline without exposing the raw SDK error to the client.
 */
export async function parseJobDescription(description: string, deps: ParseDeps = {}): Promise<ParseResult> {
	// Explicit null in deps means "no key available" (test seam). Undefined
	// means "fall back to the env var".
	const apiKey = "apiKey" in deps ? deps.apiKey : process.env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		return {
			ok: false,
			status: 503,
			error: "Sonnet assist requires ANTHROPIC_API_KEY.",
		};
	}

	const clientFactory = deps.clientFactory ?? defaultClientFactory;
	const client = clientFactory(apiKey);
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const model = deps.model ?? DEFAULT_MODEL;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await client.messages.create(
			{
				model,
				max_tokens: 1024,
				system: SYSTEM_PROMPT,
				tools: [
					{
						name: "propose_job",
						description:
							"Propose a structured scheduled-job payload that the operator will review and edit before saving.",
						input_schema: PROPOSE_JOB_INPUT_SCHEMA as unknown as {
							type: "object";
							properties?: unknown;
							required?: string[];
						},
					},
				],
				tool_choice: { type: "tool", name: "propose_job" },
				messages: [{ role: "user", content: description }],
			},
			{ signal: controller.signal },
		);

		const toolBlock = response.content.find((b): b is { type: "tool_use"; input: unknown; name: string; id: string } => {
			return (b as { type?: string }).type === "tool_use" && (b as { name?: string }).name === "propose_job";
		});

		if (!toolBlock) {
			return {
				ok: false,
				status: 422,
				error: "Could not parse description, please fill the form manually.",
			};
		}

		const parsed = JobCreateInputSchema.safeParse(toolBlock.input);
		if (!parsed.success) {
			return {
				ok: false,
				status: 422,
				error: "Could not parse description, please fill the form manually.",
			};
		}

		return {
			ok: true,
			proposal: parsed.data,
			warnings: [],
		};
	} catch (err: unknown) {
		const msg = extractErrorMessage(err);
		if (controller.signal.aborted || /abort|timeout/i.test(msg)) {
			return {
				ok: false,
				status: 504,
				error: "Sonnet assist timed out, please fill the form manually.",
			};
		}
		return {
			ok: false,
			status: 422,
			error: "Could not parse description, please fill the form manually.",
		};
	} finally {
		clearTimeout(timer);
	}
}
