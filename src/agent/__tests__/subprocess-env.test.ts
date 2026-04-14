import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PHANTOM_SECRET_ENV_VARS, buildAgentEnv } from "../subprocess-env.ts";

describe("PHANTOM_SECRET_ENV_VARS", () => {
	test("includes GitHub App credentials", () => {
		expect(PHANTOM_SECRET_ENV_VARS.has("GITHUB_APP_PRIVATE_KEY_B64")).toBe(true);
		expect(PHANTOM_SECRET_ENV_VARS.has("GITHUB_APP_ID")).toBe(true);
		expect(PHANTOM_SECRET_ENV_VARS.has("GITHUB_APP_INSTALLATION_ID")).toBe(true);
	});

	test("includes channel tokens", () => {
		expect(PHANTOM_SECRET_ENV_VARS.has("SLACK_BOT_TOKEN")).toBe(true);
		expect(PHANTOM_SECRET_ENV_VARS.has("SLACK_APP_TOKEN")).toBe(true);
		expect(PHANTOM_SECRET_ENV_VARS.has("TELEGRAM_BOT_TOKEN")).toBe(true);
	});

	test("includes provider API keys", () => {
		expect(PHANTOM_SECRET_ENV_VARS.has("ANTHROPIC_API_KEY")).toBe(true);
		expect(PHANTOM_SECRET_ENV_VARS.has("ZAI_API_KEY")).toBe(true);
		expect(PHANTOM_SECRET_ENV_VARS.has("OPENROUTER_API_KEY")).toBe(true);
	});
});

describe("buildAgentEnv", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		// Reset env to a known state
		for (const key of Object.keys(process.env)) {
			delete process.env[key];
		}
		// Set some baseline env vars
		process.env.PATH = "/usr/bin:/bin";
		process.env.HOME = "/home/test";
		process.env.LANG = "en_US.UTF-8";
	});

	afterEach(() => {
		// Restore original env
		for (const key of Object.keys(process.env)) {
			delete process.env[key];
		}
		Object.assign(process.env, originalEnv);
	});

	test("excludes GITHUB_APP_PRIVATE_KEY_B64", () => {
		process.env.GITHUB_APP_PRIVATE_KEY_B64 = "secret-private-key";
		const result = buildAgentEnv({});
		expect(result.GITHUB_APP_PRIVATE_KEY_B64).toBeUndefined();
	});

	test("excludes SLACK_BOT_TOKEN", () => {
		process.env.SLACK_BOT_TOKEN = "xoxb-secret-token";
		const result = buildAgentEnv({});
		expect(result.SLACK_BOT_TOKEN).toBeUndefined();
	});

	test("excludes ANTHROPIC_API_KEY from inherited env", () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-inherited";
		const result = buildAgentEnv({});
		expect(result.ANTHROPIC_API_KEY).toBeUndefined();
	});

	test("preserves PATH and HOME", () => {
		const result = buildAgentEnv({});
		expect(result.PATH).toBe("/usr/bin:/bin");
		expect(result.HOME).toBe("/home/test");
	});

	test("preserves LANG", () => {
		const result = buildAgentEnv({});
		expect(result.LANG).toBe("en_US.UTF-8");
	});

	test("providerEnv values take precedence", () => {
		// Even if ANTHROPIC_API_KEY was in process.env, providerEnv should win
		const result = buildAgentEnv({ ANTHROPIC_API_KEY: "sk-ant-provider" });
		expect(result.ANTHROPIC_API_KEY).toBe("sk-ant-provider");
	});

	test("includes non-secret env vars", () => {
		process.env.CUSTOM_VAR = "custom-value";
		process.env.NODE_ENV = "development";
		const result = buildAgentEnv({});
		expect(result.CUSTOM_VAR).toBe("custom-value");
		expect(result.NODE_ENV).toBe("development");
	});

	test("excludes all secret env vars", () => {
		// Set all known secrets
		for (const secret of PHANTOM_SECRET_ENV_VARS) {
			process.env[secret] = `secret-value-${secret}`;
		}

		const result = buildAgentEnv({});

		// None should be present
		for (const secret of PHANTOM_SECRET_ENV_VARS) {
			expect(result[secret]).toBeUndefined();
		}
	});
});
