// Notification payload factories. Each returns a structured payload
// under 2048 bytes cleartext for the push service.

export type NotificationPayload = {
	title: string;
	body: string;
	tag: string;
	data: {
		url: string;
		type: string;
		sessionId?: string;
	};
};

export function sessionCompletePayload(sessionId: string, title: string, durationMs: number): NotificationPayload {
	const durationSec = Math.round(durationMs / 1000);
	const durationLabel = durationSec >= 60 ? `${Math.round(durationSec / 60)}m` : `${durationSec}s`;
	const body = title ? `${title} (${durationLabel})` : `Task finished in ${durationLabel}`;

	return {
		title: "Task complete",
		body,
		tag: `session-complete-${sessionId}`,
		data: {
			url: `/chat/s/${sessionId}`,
			type: "session_complete",
			sessionId,
		},
	};
}

export function agentMessagePayload(sessionId: string, preview: string): NotificationPayload {
	const truncated = preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
	return {
		title: "New message",
		body: truncated,
		tag: `agent-message-${sessionId}`,
		data: {
			url: `/chat/s/${sessionId}`,
			type: "agent_message",
			sessionId,
		},
	};
}

export function scheduledJobPayload(jobName: string, status: string): NotificationPayload {
	return {
		title: `Scheduled: ${jobName}`,
		body: status,
		tag: `scheduled-${jobName}`,
		data: {
			url: "/chat/",
			type: "scheduled_result",
		},
	};
}

export function hardErrorPayload(sessionId: string, error: string): NotificationPayload {
	const truncated = error.length > 120 ? `${error.slice(0, 117)}...` : error;
	return {
		title: "Error",
		body: truncated,
		tag: `error-${sessionId}`,
		data: {
			url: `/chat/s/${sessionId}`,
			type: "hard_error",
			sessionId,
		},
	};
}

export function testPayload(): NotificationPayload {
	return {
		title: "Phantom",
		body: "Push notifications are working",
		tag: "test-notification",
		data: {
			url: "/chat/",
			type: "test",
		},
	};
}
