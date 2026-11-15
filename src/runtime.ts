import { Kysely, type Dialect } from "kysely";
import { currentSite, siteDialect } from "./dialect.ts";
import { activeSite, scopeState } from "./scope.ts";
import { resolveSite, shardOf, type SitesConfig } from "./sites.ts";

/** Config the wrapped descriptor hands to its runtime entrypoint. */
export interface TenancyConfig<InnerConfig = unknown> {
	inner: InnerConfig;
	sites: SitesConfig;
}

/** Subset of core's RequestScopedDbOpts this wrapper reads. */
interface ScopedOpts {
	config: unknown;
	url: URL;
}

export interface RuntimeOptions {
	/** Site -> shard binding (`undefined` = the descriptor's database). Defaults to `shardOf`; the self-checks override it. */
	shardOf?: (site: string, sites: SitesConfig) => string | undefined;
}

/**
 * Build the `createDialect` / `createRequestScopedDb` pair core expects from a
 * descriptor entrypoint, around an inner adapter's `createDialect`.
 *
 * ponytail: one database config per isolate (a Worker has exactly one DB
 * descriptor), so the inner dialects and per-site Kysely instances are cached
 * at module scope without keying on config.
 */
export function makeRuntime<InnerConfig>(createInner: (config: InnerConfig) => Dialect, opts: RuntimeOptions = {}) {
	const shardFor = opts.shardOf ?? shardOf;
	let inner: Dialect | undefined;
	const getInner = (c: TenancyConfig<InnerConfig>) => {
		inner ??= createInner(c.inner);
		scopeState().inner = inner;
		return inner;
	};
	// One inner dialect per shard binding, built on first use. Each shard is its own database, so
	// each gets its own shared driver (siteDialect keys that on the inner dialect).
	const shardInners = new Map<string, Dialect>();
	const innerFor = (c: TenancyConfig<InnerConfig>, site: string): Dialect => {
		// The primary short-circuits before the lookup so a bad `shardOf` can never move it off the main database.
		const shard = site === c.sites.primary ? undefined : shardFor(site, c.sites);
		if (shard === undefined) return getInner(c);
		let d = shardInners.get(shard);
		if (!d) {
			// Fail closed: never serve a site from a database the config does not declare.
			if (!c.sites.shards?.includes(shard)) throw new Error(`[multisite] site ${site} is on shard ${shard}, which is not in sites.shards`);
			d = createInner({ ...(c.inner as object), binding: shard } as InnerConfig);
			shardInners.set(shard, d);
		}
		return d;
	};
	const perSite = new Map<string, Kysely<unknown>>();

	return {
		/**
		 * Singleton path: boot, migrations, cron. Site comes from `runAsSite`, else primary.
		 *
		 * ponytail: always the descriptor's database, which is right while every site lives there.
		 * Routing the singleton per site comes with shard assignment.
		 */
		createDialect(config: TenancyConfig<InnerConfig>): Dialect {
			scopeState().primary = config.sites.primary;
			// The shared singleton also serves per-site runtimes, so its site is resolved per query
			// (request's site handle, else runAsSite, else primary), never fixed at creation.
			return siteDialect(getInner(config), activeSite, config.sites.primary);
		},

		/**
		 * Per-request path: the site is resolved from the hostname and baked into
		 * a cached per-site Kysely over its shard's database, so nothing downstream
		 * can run unscoped. Always returns a handle (never null), or core would fall
		 * back to the primary-site singleton for every request.
		 */
		createRequestScopedDb(opts: ScopedOpts): { db: Kysely<unknown>; commit: () => void } {
			const config = opts.config as TenancyConfig<InnerConfig>;
			// Core also asks for a scoped db with a fixed internal URL (`withEmDashRuntime`, cron
			// events). That URL says nothing about the site, so use the site the outer middleware
			// already set for this request; only a real request URL is resolved by hostname.
			const site =
				opts.url.hostname.endsWith(".emdash.internal") && currentSite()
					? currentSite()!
					: resolveSite(opts.url.hostname, config.sites);
			let db = perSite.get(site);
			if (!db) {
				db = new Kysely<unknown>({ dialect: siteDialect(innerFor(config, site), () => site, config.sites.primary) });
				perSite.set(site, db);
				scopeState().siteOfDb.set(db, site);
			}
			scopeState().primary = config.sites.primary;
			return { db, commit: () => {} };
		},
	};
}
