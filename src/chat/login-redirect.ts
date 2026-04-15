// Same-origin redirect validation for login flow.
// Accepts a redirect URL from ?redirect= query param. Returns null if the
// URL is not same-origin (must start with "/" and not "//") to prevent
// open-redirect attacks.

export function validateRedirect(url: string | null): string | null {
	if (!url || typeof url !== "string") return null;

	const trimmed = url.trim();
	if (!trimmed) return null;

	// Must start with a single slash (relative same-origin path)
	if (!trimmed.startsWith("/")) return null;

	// Reject protocol-relative URLs ("//evil.com")
	if (trimmed.startsWith("//")) return null;

	// Reject URLs with embedded credentials or weird schemes
	try {
		const parsed = new URL(trimmed, "http://localhost");
		if (parsed.username || parsed.password) return null;
	} catch {
		return null;
	}

	return trimmed;
}
