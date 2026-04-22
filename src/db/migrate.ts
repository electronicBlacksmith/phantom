import type { Database } from "bun:sqlite";
import { MIGRATIONS } from "./schema.ts";

export function runMigrations(db: Database): void {
	db.run(`CREATE TABLE IF NOT EXISTS _migrations (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		index_num INTEGER UNIQUE NOT NULL,
		applied_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`);

	const applied = new Set(
		db
			.query("SELECT index_num FROM _migrations")
			.all()
			.map((row) => (row as { index_num: number }).index_num),
	);

	for (let i = 0; i < MIGRATIONS.length; i++) {
		if (applied.has(i)) continue;
		try {
			db.run(MIGRATIONS[i]);
		} catch (error) {
			// SQLite raises "duplicate column name" when ALTER TABLE ADD COLUMN
			// re-runs on a DB that already has the column. Earlier fork deploys
			// may have applied ALTERs at indices the runner now considers new
			// (e.g. after a migration renumbering). Treat that single failure
			// mode as idempotent and record the row; any other error propagates.
			const msg = error instanceof Error ? error.message : String(error);
			if (!msg.includes("duplicate column name")) throw error;
		}
		db.run("INSERT INTO _migrations (index_num) VALUES (?)", [i]);
	}
}
