// Helpers for security-wrapping MessageParam content. Typed with `unknown`
// internally to work even when @anthropic-ai/sdk types are not resolvable
// on CI (the agent SDK imports MessageParam from a transitive dep that
// does not reliably hoist in all package managers).

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

type MessageParam = SDKUserMessage["message"];

export function extractTextFromMessageParam(message: MessageParam): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	const texts: string[] = [];
	for (const block of message.content as unknown[]) {
		const b = block as { type?: string; text?: string };
		if (b.type === "text" && b.text) texts.push(b.text);
	}
	return texts.join("\n");
}

export function wrapMessageContent(message: MessageParam, wrappedText: string): MessageParam {
	if (typeof message.content === "string") {
		return { ...message, content: wrappedText };
	}
	if (!Array.isArray(message.content)) {
		return { ...message, content: wrappedText };
	}
	const wrapped = [];
	for (const block of message.content as unknown[]) {
		const b = block as { type?: string };
		if (b.type === "text") {
			wrapped.push({ ...(block as Record<string, unknown>), text: wrappedText });
		} else {
			wrapped.push(block);
		}
	}
	return { ...message, content: wrapped as typeof message.content };
}
