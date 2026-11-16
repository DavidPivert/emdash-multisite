import type { DatabaseDescriptor } from "emdash/db";
import { assertSitesConfig, type SitesConfig } from "./sites.ts";

export { runAsSite } from "./dialect.ts";
export { multisitePlugin } from "./plugin.ts";
export { resolveSite, type SitesConfig } from "./sites.ts";

/** Inner adapter entrypoint -> our wrapping entrypoint. */
const WRAPPERS: Record<string, string> = {
	"emdash/db/sqlite": "emdash-multisite/db/sqlite",
	"@emdash-cms/cloudflare/db/d1": "emdash-multisite/db/d1",
};

/**
 * Wrap a database descriptor so one database serves many sites.
 *
 * ```ts
 * emdash({ database: withSites(d1({ binding: "DB" }), { primary: "main", wildcard: "example.com" }) })
 * ```
 */
export function withSites(inner: DatabaseDescriptor, sites: SitesConfig): DatabaseDescriptor {
	assertSitesConfig(sites);
	const entrypoint = WRAPPERS[inner.entrypoint];
	if (!entrypoint) {
		throw new Error(`[multisite] unsupported database adapter: ${inner.entrypoint}`);
	}
	if (sites.shards?.length) {
		// A shard is another D1 binding: the Node/SQLite adapter has no binding to swap.
		if (inner.entrypoint !== "@emdash-cms/cloudflare/db/d1") throw new Error("[multisite] shards need the d1() adapter");
		const own = (inner.config as { binding?: string } | undefined)?.binding;
		if (own && sites.shards.includes(own)) throw new Error(`[multisite] shards must not list the main binding ${own}`);
	}
	return {
		entrypoint,
		config: { inner: inner.config, sites },
		type: inner.type,
		supportsRequestScope: true,
		// Omitted on purpose: `migrations` (deploy-time runner and coalescing and
		// the collection-deletion guard address one site's tables only).
	};
}
