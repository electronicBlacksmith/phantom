/**
 * Environment variable filtering for agent subprocess execution.
 *
 * The Agent SDK runs Claude Code as a subprocess that inherits environment
 * variables from the parent process. This module ensures secrets are stripped
 * before being passed to the subprocess, preventing accidental disclosure via
 * shell commands like `env` or `printenv`.
 *
 * Provider credentials (ANTHROPIC_API_KEY, ZAI_API_KEY, etc.) are re-injected
 * via the providerEnv parameter, not inherited from process.env.
 */

/**
 * Environment variables that must NEVER be passed to the agent subprocess.
 *
 * These include:
 * - GitHub App credentials (private key, app ID, installation ID)
 * - Channel tokens (Slack, Telegram, email SMTP)
 * - Internal secrets (encryption key, Resend API key)
 * - Provider API keys (re-injected via providerEnv, not inherited)
 */
export const PHANTOM_SECRET_ENV_VARS = new Set([
	// GitHub App credentials
	"GITHUB_APP_PRIVATE_KEY_B64",
	"GITHUB_APP_ID",
	"GITHUB_APP_CLIENT_ID",
	"GITHUB_APP_INSTALLATION_ID",

	// Channel tokens
	"SLACK_BOT_TOKEN",
	"SLACK_APP_TOKEN",
	"TELEGRAM_BOT_TOKEN",

	// Internal secrets
	"SECRET_ENCRYPTION_KEY",
	"RESEND_API_KEY",
	"MCP_AUTH_SECRET",

	// Provider API keys (re-injected via providerEnv)
	"ANTHROPIC_API_KEY",
	"ZAI_API_KEY",
	"OPENROUTER_API_KEY",
	"OLLAMA_API_KEY",
	"VLLM_API_KEY",
	"LITELLM_API_KEY",
]);

/**
 * Build a filtered environment for the Agent SDK subprocess.
 *
 * Strips all known secret variables from process.env, then merges in the
 * provider-specific credentials that the SDK actually needs. This ensures
 * the subprocess can authenticate to the LLM provider while preventing
 * shell commands from leaking other secrets.
 *
 * @param providerEnv - Provider credentials to inject (e.g., { ANTHROPIC_API_KEY: "..." })
 * @returns Filtered environment safe for subprocess execution
 */
export function buildAgentEnv(providerEnv: Record<string, string>): Record<string, string> {
	const filtered: Record<string, string> = {};

	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !PHANTOM_SECRET_ENV_VARS.has(key)) {
			filtered[key] = value;
		}
	}

	// Provider credentials take precedence over any inherited values
	return { ...filtered, ...providerEnv };
}
