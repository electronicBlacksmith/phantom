// Resolve and validate memory file paths under the user-scope .claude directory.
//
// Memory files are arbitrary `.md` files the operator writes as instructions for
// their agent. They live under /home/phantom/.claude/ (the user-scope settings
// root that the SDK loads). We expose everything under that root EXCEPT:
//
//   - skills/**  (has its own tab)
//   - plugins/** (PR2 scope)
//   - agents/**  (PR3 scope)
//   - settings.json, settings.local.json (PR3 scope, JSON not markdown)
//   - any non-.md file
//   - hidden files (names starting with '.')
//
// Paths are always validated to live canonically under the root.

import { homedir } from "node:os";
import { resolve } from "node:path";

const USER_ENV_OVERRIDE = "PHANTOM_MEMORY_FILES_ROOT";

// Segments under .claude that we do NOT expose as memory files.
// Top-level hits are excluded; nested hits with the same top-level segment
// are also excluded.
export const EXCLUDED_TOP_DIRS = new Set<string>(["skills", "plugins", "agents"]);
export const EXCLUDED_TOP_FILES = new Set<string>(["settings.json", "settings.local.json"]);

export function getMemoryFilesRoot(): string {
	const override = process.env[USER_ENV_OVERRIDE];
	if (override) {
		return resolve(override);
	}
	return resolve(homedir(), ".claude");
}

// The public-facing "path" is the relative path from the memory files root,
// always POSIX-style. We validate that:
//   - path has no null bytes
//   - path does not start with '/' or '\\'
//   - path has no '..' segments
//   - path ends with '.md'
//   - path is not a hidden file (no segment starts with '.')
//   - path is not under an excluded top-level directory
//   - path is not an excluded top-level file
export function isValidMemoryFilePath(relative: string): boolean {
	if (typeof relative !== "string" || relative.length === 0) return false;
	if (relative.includes("\0")) return false;
	if (relative.startsWith("/") || relative.startsWith("\\")) return false;
	if (!relative.endsWith(".md")) return false;

	const segments = relative.split("/").filter((s) => s.length > 0);
	if (segments.length === 0) return false;

	for (const seg of segments) {
		if (seg === "." || seg === "..") return false;
		if (seg.startsWith(".")) return false;
	}

	const top = segments[0];
	if (segments.length === 1 && EXCLUDED_TOP_FILES.has(top)) return false;
	if (EXCLUDED_TOP_DIRS.has(top)) return false;

	return true;
}

export function resolveMemoryFilePath(relative: string): { root: string; absolute: string } {
	if (!isValidMemoryFilePath(relative)) {
		throw new Error(`Invalid memory file path: ${JSON.stringify(relative)}`);
	}
	const root = getMemoryFilesRoot();
	const absolute = resolve(root, relative);
	if (!absolute.startsWith(`${root}/`) && absolute !== root) {
		throw new Error(`Path escape detected: ${absolute} is not inside ${root}`);
	}
	return { root, absolute };
}
