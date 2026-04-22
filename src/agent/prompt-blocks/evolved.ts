import type { EvolvedConfig } from "../../evolution/types.ts";

// Assembles the "evolved" portion of the system prompt from the live
// EvolvedConfig: communication style, user profile, domain knowledge, and
// learned strategies. The constitution is injected separately at the top of
// the system prompt by assemblePrompt's buildConstitution helper, which
// reads phantom-config/constitution.md directly from disk. That positioning
// makes the constitution a load-bearing top-level section rather than being
// buried inside the evolved block, which is what PR #23 established.
export function buildEvolvedSections(evolved: EvolvedConfig): string {
	const parts: string[] = [];

	if (evolved.persona.trim() && countContentLines(evolved.persona) > 1) {
		parts.push(`# Communication Style\n\n${evolved.persona.trim()}`);
	}

	if (evolved.userProfile.trim() && countContentLines(evolved.userProfile) > 1) {
		parts.push(`# User Profile\n\n${evolved.userProfile.trim()}`);
	}

	if (evolved.domainKnowledge.trim() && countContentLines(evolved.domainKnowledge) > 1) {
		parts.push(`# Domain Knowledge\n\n${evolved.domainKnowledge.trim()}`);
	}

	const strategyParts: string[] = [];
	if (evolved.strategies.taskPatterns.trim() && countContentLines(evolved.strategies.taskPatterns) > 1) {
		strategyParts.push(evolved.strategies.taskPatterns.trim());
	}
	if (evolved.strategies.toolPreferences.trim() && countContentLines(evolved.strategies.toolPreferences) > 1) {
		strategyParts.push(evolved.strategies.toolPreferences.trim());
	}
	if (evolved.strategies.errorRecovery.trim() && countContentLines(evolved.strategies.errorRecovery) > 1) {
		strategyParts.push(evolved.strategies.errorRecovery.trim());
	}
	if (strategyParts.length > 0) {
		parts.push(`# Learned Strategies\n\n${strategyParts.join("\n\n")}`);
	}

	if (parts.length === 0) return "";

	return parts.join("\n\n");
}

function countContentLines(text: string): number {
	return text.split("\n").filter((line) => {
		const trimmed = line.trim();
		return trimmed !== "" && !trimmed.startsWith("#");
	}).length;
}
