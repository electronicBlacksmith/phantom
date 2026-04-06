import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { hashTokenSync } from "../../mcp/config.ts";
import type { McpConfig } from "../../mcp/types.ts";
import { setTriggerDeps, startServer } from "../server.ts";

/**
 * Tests that the /trigger endpoint requires bearer token auth
 * with operator scope. Closes ghostwright/phantom#9.
 */
describe("/trigger endpoint auth", () => {
	const adminToken = "test-trigger-admin-token";
	const readToken = "test-trigger-read-token";
	const operatorToken = "test-trigger-operator-token";

	const mcpConfigPath = "config/mcp.yaml";
	let originalMcpYaml: string | null = null;
	let server: ReturnType<typeof Bun.serve>;
	let baseUrl: string;

	beforeAll(async () => {
		// Back up the existing mcp.yaml so we can restore it after tests
		if (existsSync(mcpConfigPath)) {
			originalMcpYaml = readFileSync(mcpConfigPath, "utf-8");
		}

		// Write test tokens to mcp.yaml so loadMcpConfig picks them up
		const mcpConfig: McpConfig = {
			tokens: [
				{ name: "admin", hash: hashTokenSync(adminToken), scopes: ["read", "operator", "admin"] },
				{ name: "reader", hash: hashTokenSync(readToken), scopes: ["read"] },
				{ name: "operator", hash: hashTokenSync(operatorToken), scopes: ["read", "operator"] },
			],
			rate_limit: { requests_per_minute: 60, burst: 10 },
		};

		mkdirSync("config", { recursive: true });
		writeFileSync(mcpConfigPath, YAML.stringify(mcpConfig), "utf-8");

		// Wire trigger deps before starting the server so the /trigger
		// handler is ready on the first request.
		setTriggerDeps({
			runtime: {
				handleMessage: async () => ({
					text: "ok",
					cost: { totalUsd: 0 },
					durationMs: 0,
				}),
			} as never,
		});

		// Start server after deps are wired. Use server.url (Bun guarantees
		// it is populated once serve() returns) instead of manually building
		// the URL from server.port, which can race in CI environments.
		server = startServer({ name: "test", port: 0, role: "base" } as never, Date.now());
		baseUrl = server.url.origin;

		// Ensure the server is accepting connections before tests run.
		await fetch(`${baseUrl}/health`);
	});

	afterAll(() => {
		server?.stop(true);
		// Restore the original mcp.yaml
		if (originalMcpYaml !== null) {
			writeFileSync(mcpConfigPath, originalMcpYaml, "utf-8");
		}
	});

	const triggerBody = JSON.stringify({ task: "hello" });

	test("rejects request with no Authorization header", async () => {
		const res = await fetch(`${baseUrl}/trigger`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: triggerBody,
		});
		expect(res.status).toBe(401);
		const json = (await res.json()) as { status: string; message: string };
		expect(json.message).toContain("Missing");
	});

	test("rejects request with invalid token", async () => {
		const res = await fetch(`${baseUrl}/trigger`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer wrong-token",
			},
			body: triggerBody,
		});
		expect(res.status).toBe(401);
	});

	test("rejects read-only token (insufficient scope)", async () => {
		const res = await fetch(`${baseUrl}/trigger`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${readToken}`,
			},
			body: triggerBody,
		});
		expect(res.status).toBe(403);
		const json = (await res.json()) as { status: string; message: string };
		expect(json.message).toContain("operator");
	});

	test("accepts operator token", async () => {
		const res = await fetch(`${baseUrl}/trigger`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${operatorToken}`,
			},
			body: triggerBody,
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as { status: string };
		expect(json.status).toBe("ok");
	});

	test("accepts admin token", async () => {
		const res = await fetch(`${baseUrl}/trigger`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${adminToken}`,
			},
			body: triggerBody,
		});
		expect(res.status).toBe(200);
	});
});
