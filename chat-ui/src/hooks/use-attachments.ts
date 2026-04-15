// Shared attachment state and file acceptance logic.
// Three triggers (paste, drop, click) all funnel into addFiles.

import { useCallback, useState } from "react";
import { toast } from "sonner";

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_FILES = 10;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

export type PendingAttachment = {
	id: string;
	file: File;
	previewUrl: string | null;
	status: "pending" | "uploading" | "done" | "error";
	serverId?: string;
};

export type AttachmentResult = {
	id: string;
	filename: string;
	mime_type: string;
	size: number;
	preview_url: string;
};

export function useAttachments(): {
	files: PendingAttachment[];
	addFiles: (newFiles: File[]) => void;
	removeFile: (id: string) => void;
	clearFiles: () => void;
	uploadFiles: (sessionId: string) => Promise<string[]>;
	hasFiles: boolean;
	isUploading: boolean;
} {
	const [files, setFiles] = useState<PendingAttachment[]>([]);

	const addFiles = useCallback(
		(newFiles: File[]) => {
			setFiles((prev) => {
				const remaining = MAX_FILES - prev.length;
				if (remaining <= 0) {
					toast.error(`Limit of ${MAX_FILES} files reached.`);
					return prev;
				}

				const toAdd = newFiles.slice(0, remaining);
				if (newFiles.length > remaining) {
					toast.error(`Limit of ${MAX_FILES} files reached. ${newFiles.length - remaining} files skipped.`);
				}

				const added: PendingAttachment[] = [];
				for (const file of toAdd) {
					if (file.type === "image/heic" || file.type === "image/heif") {
						toast.error("iOS HEIC photos are not supported. Please choose JPEG export from the Photos app.");
						continue;
					}
					if (file.size > MAX_FILE_SIZE) {
						toast.error(`"${file.name}" is too large. Max 10 MB.`);
						continue;
					}

					const isImage = IMAGE_MIMES.has(file.type);
					const previewUrl = isImage ? URL.createObjectURL(file) : null;

					added.push({
						id: crypto.randomUUID(),
						file,
						previewUrl,
						status: "pending",
					});
				}

				return [...prev, ...added];
			});
		},
		[],
	);

	const removeFile = useCallback((id: string) => {
		setFiles((prev) => {
			const item = prev.find((f) => f.id === id);
			if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
			return prev.filter((f) => f.id !== id);
		});
	}, []);

	const clearFiles = useCallback(() => {
		setFiles((prev) => {
			for (const f of prev) {
				if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
			}
			return [];
		});
	}, []);

	const uploadFiles = useCallback(
		async (sessionId: string): Promise<string[]> => {
			const pending = files.filter((f) => f.status === "pending");
			if (pending.length === 0) return [];

			setFiles((prev) => prev.map((f) => (f.status === "pending" ? { ...f, status: "uploading" as const } : f)));

			const formData = new FormData();
			for (const p of pending) {
				formData.append("file", p.file);
			}

			try {
				const res = await fetch(`/chat/sessions/${sessionId}/attachments`, {
					method: "POST",
					credentials: "include",
					body: formData,
				});

				const body = (await res.json()) as {
					attachments?: AttachmentResult[];
					rejected?: Array<{ filename: string; reason: string; message: string }>;
				};

				if (body.rejected) {
					for (const r of body.rejected) {
						toast.error(r.message || `"${r.filename}" was rejected.`);
					}
				}

				const serverIds = (body.attachments ?? []).map((a) => a.id);

				setFiles((prev) =>
					prev.map((f) => (f.status === "uploading" ? { ...f, status: "done" as const } : f)),
				);

				return serverIds;
			} catch {
				setFiles((prev) =>
					prev.map((f) => (f.status === "uploading" ? { ...f, status: "error" as const } : f)),
				);
				toast.error("Upload failed. Please try again.");
				return [];
			}
		},
		[files],
	);

	return {
		files,
		addFiles,
		removeFile,
		clearFiles,
		uploadFiles,
		hasFiles: files.length > 0,
		isUploading: files.some((f) => f.status === "uploading"),
	};
}
