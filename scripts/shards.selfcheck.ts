/**
 * Runnable self-check (no framework): `node --no-warnings scripts/shards.selfcheck.ts`.
 *
 * The shard pool plumbing: `SitesConfig.shards` is validated, and the runtime keeps one
 * inner dialect per shard binding. By default every site stays in the descriptor's
 * database (no behaviour change); with a site -> shard lookup, a site's per-request
 * Kysely reads its shard's database and nothing else.
 */
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { sql, type Dialect, type Kysely } from "kysely";
import { createDialect } from "emdash/db/sqlite";
import { makeRuntime } from "../src/runtime.ts";
import { assertSitesConfig, shardOf, type SitesConfig } from "../src/sites.ts";
import { withSites } from "../src/index.ts";

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failed++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};
const throws = (fn: () => unknown): string => {
	try {
		fn();
		return "no error";
	} catch (e) {
		return (e as Error).message;
	}
};

// ---------- Config validation ----------
const base: SitesConfig = { primary: "main", wildcard: "example.com" };
eq("no shards is valid", throws(() => assertSitesConfig(base)), "no error");
eq("binding names are valid", throws(() => assertSitesConfig({ ...base, shards: ["DB_SHARD_1", "DB_SHARD_2"] })), "no error");
eq("a binding name with a dash is refused", throws(() => assertSitesConfig({ ...base, shards: ["DB-2"] })), "[multisite] shards must be D1 binding names like DB_SHARD_1");
eq("a duplicate binding is refused", throws(() => assertSitesConfig({ ...base, shards: ["DB_2", "DB_2"] })), "[multisite] shards lists a binding twice");
const d1 = { entrypoint: "@emdash-cms/cloudflare/db/d1", config: { binding: "DB" }, type: "sqlite" } as never;
const sqlite = { entrypoint: "emdash/db/sqlite", config: { url: "file:x.db" }, type: "sqlite" } as never;
eq("withSites accepts shards on d1()", throws(() => withSites(d1, { ...base, shards: ["DB_2"] })), "no error");
eq("withSites refuses the main binding as a shard", throws(() => withSites(d1, { ...base, shards: ["DB"] })), "[multisite] shards must not list the main binding DB");
eq("withSites refuses shards on the SQLite adapter", throws(() => withSites(sqlite, { ...base, shards: ["DB_2"] })), "[multisite] shards need the d1() adapter");
eq("withSites without shards still accepts the SQLite adapter", throws(() => withSites(sqlite, base)), "no error");
eq("every site lives in the descriptor's database for now", ["main", "acme", "globex"].map((s) => shardOf(s, { ...base, shards: ["DB_2"] })), [undefined, undefined, undefined]);

// ---------- Two databases: "DB" (the descriptor's) and "DB_2" (a shard) ----------
const file = (binding: string) => `/tmp/emdash-multisite-shards-${binding}.db`;
for (const b of ["DB", "DB_2"]) for (const s of ["", "-wal", "-shm"]) rmSync(file(b) + s, { force: true });
// Each database holds a title for the sites it might serve, tagged with the database name,
// so a read shows which database answered.
const seed = (binding: string, tables: string[]) => {
	const raw = new DatabaseSync(file(binding));
	for (const t of tables) {
		raw.exec(`CREATE TABLE "${t}" (name TEXT PRIMARY KEY, value TEXT)`);
		raw.prepare(`INSERT INTO "${t}" (name, value) VALUES ('site.title', ?)`).run(`${binding}:${t}`);
	}
	raw.close();
};
seed("DB", ["options", "options$acme", "options$globex"]);
seed("DB_2", ["options", "options$acme", "options$globex"]);

/** Inner adapter stand-in: one SQLite file per binding, and a log of which bindings were built. */
const built: string[] = [];
const createInner = (c: { binding: string }): Dialect => {
	built.push(c.binding);
	return createDialect({ url: `file:${file(c.binding)}` });
};
const title = async (h: { db: Kysely<unknown> }) =>
	(await sql<{ value: string }>`SELECT value FROM options WHERE name = ${"site.title"}`.execute(h.db)).rows.map((r) => r.value);
const request = (rt: ReturnType<typeof makeRuntime<{ binding: string }>>, cfg: unknown, host: string) =>
	rt.createRequestScopedDb({ config: cfg, url: new URL(`https://${host}/`) });

// Default lookup: no behaviour change, even with a pool declared.
{
	built.length = 0;
	const rt = makeRuntime(createInner);
	const cfg = { inner: { binding: "DB" }, sites: { ...base, shards: ["DB_2"] } };
	eq(
		"default: every site reads the descriptor's database",
		[await title(request(rt, cfg, "example.com")), await title(request(rt, cfg, "acme.example.com")), await title(request(rt, cfg, "globex.example.com"))],
		[["DB:options"], ["DB:options$acme"], ["DB:options$globex"]],
	);
	eq("default: the shard database is never opened", built, ["DB"]);
}

// A lookup that puts globex on DB_2: the second binding is reachable, and only for that site.
{
	built.length = 0;
	const rt = makeRuntime(createInner, { shardOf: (site) => (site === "globex" || site === "main" ? "DB_2" : undefined) });
	const cfg = { inner: { binding: "DB" }, sites: { ...base, shards: ["DB_2"] } };
	const globex = request(rt, cfg, "globex.example.com");
	eq("shard: globex reads its own tables in DB_2", await title(globex), ["DB_2:options$globex"]);
	eq("shard: acme still reads DB", await title(request(rt, cfg, "acme.example.com")), ["DB:options$acme"]);
	eq("shard: the primary site always stays in DB, whatever the lookup says", await title(request(rt, cfg, "example.com")), ["DB:options"]);
	eq("shard: the per-site Kysely is cached", request(rt, cfg, "globex.example.com").db === globex.db, true);
	eq("shard: each binding's dialect is built once", built.sort(), ["DB", "DB_2"]);
}

// A site on an undeclared binding fails closed instead of falling back to another database.
{
	const rt = makeRuntime(createInner, { shardOf: () => "DB_9" });
	const cfg = { inner: { binding: "DB" }, sites: { ...base, shards: ["DB_2"] } };
	eq(
		"shard: an undeclared binding is refused",
		throws(() => request(rt, cfg, "acme.example.com")),
		"[multisite] site acme is on shard DB_9, which is not in sites.shards",
	);
}

for (const b of ["DB", "DB_2"]) for (const s of ["", "-wal", "-shm"]) rmSync(file(b) + s, { force: true });
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
