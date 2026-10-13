import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { grep, isHeldBySqlite } from "../native/index.js";

/** Opens and closes `dbPath` in a separate process; the last connection out checkpoints and unlinks the WAL. */
function peerOpenClose(dbPath: string): void {
	const script = `const { Database } = require("bun:sqlite"); const db = new Database(${JSON.stringify(dbPath)}); db.query("SELECT count(*) FROM t").get(); db.close();`;
	const peer = Bun.spawnSync([process.execPath, "-e", script]);
	expect(peer.exitCode).toBe(0);
}

// POSIX record locks are per process: closing any descriptor on the database drops them all (#15586).
describe.skipIf(process.platform === "win32")("SQLite files held by this process", () => {
	let dir: string;
	let dbPath: string;
	let db: Database;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-held-sqlite-"));
		dbPath = path.join(dir, "agent.db");
		db = new Database(dbPath);
		db.run("PRAGMA journal_mode = WAL");
		db.run("CREATE TABLE t (v TEXT)");
		db.run("INSERT INTO t (v) VALUES ('needle')");
		// Checked right after the open: the guard reads the live descriptor table, so no wait is needed.
		expect(isHeldBySqlite(dbPath)).toBe(true);
	});

	afterEach(async () => {
		db.close();
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("keeps the live connection's locks through a grep over its directory", async () => {
		await Bun.write(path.join(dir, "notes.txt"), "needle\n");
		expect(isHeldBySqlite(`${dbPath}-shm`)).toBe(true);
		expect(isHeldBySqlite(path.join(dir, "notes.txt"))).toBe(false);

		const result = await grep({ pattern: "needle", path: dir, hidden: true, gitignore: false });
		expect(result.matches.map(match => path.basename(match.path))).toEqual(["notes.txt"]);

		// With its locks intact this process still counts as a reader, so the peer must leave the WAL.
		peerOpenClose(dbPath);
		expect(await Bun.file(`${dbPath}-wal`).exists()).toBe(true);
		db.run("INSERT INTO t (v) VALUES ('after')");
		expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
	});
});
