import type { Databases, Models } from "node-appwrite";
import type { AppwriteConfig } from "@njdamstra/appwrite-utils";
import {
  ConstantsGenerator,
  type ConstantsFilterConfig,
  MessageFormatter,
} from "@njdamstra/appwrite-utils-helpers";
import { fetchAllCollections } from "../collections/methods.js";

/**
 * Extract the filter config from AppwriteConfig (reuses constantsConfig).
 * Returns undefined when no filter is configured — callers should treat that
 * as "include everything".
 */
export function getFilterConfig(
  config?: AppwriteConfig
): ConstantsFilterConfig | undefined {
  return config?.constantsConfig;
}

/**
 * Filter a list of databases.
 * Databases that are excluded BUT have `includeFrom` cherry-picks are kept
 * so that the caller can still fetch those cherry-picked collections.
 */
export function filterDatabases(
  databases: Models.Database[],
  filter?: ConstantsFilterConfig
): Models.Database[] {
  if (!filter) return databases;

  return databases.filter((db) => {
    if (ConstantsGenerator.shouldInclude(db.name, db.$id, filter.databases)) {
      return true;
    }
    // Keep excluded DBs that have cherry-pick entries
    const includeFrom = filter.collections?.includeFrom;
    if (includeFrom) {
      return Object.keys(includeFrom).some(
        (k) =>
          k.toLowerCase() === db.name.toLowerCase() ||
          k.toLowerCase() === db.$id.toLowerCase()
      );
    }
    return false;
  });
}

/**
 * Returns true if the database is fully included (not just kept for cherry-picks).
 */
export function isDatabaseIncluded(
  db: Models.Database,
  filter?: ConstantsFilterConfig
): boolean {
  return ConstantsGenerator.shouldInclude(
    db.name,
    db.$id,
    filter?.databases
  );
}

/**
 * Fetch collections for a database, respecting the filter.
 *
 * - Fully-included DBs: fetch all, then apply collection-level filter.
 * - Excluded DBs with cherry-picks: fetch only the cherry-picked IDs individually.
 * - Excluded DBs without cherry-picks: return [].
 */
export async function fetchFilteredCollections(
  dbId: string,
  dbName: string,
  database: Databases,
  filter?: ConstantsFilterConfig
): Promise<Models.Collection[]> {
  if (!filter) {
    return fetchAllCollections(dbId, database);
  }

  const dbIncluded = ConstantsGenerator.shouldInclude(
    dbName,
    dbId,
    filter.databases
  );

  const includeFrom = filter.collections?.includeFrom;
  const cherryPickList = includeFrom
    ? Object.entries(includeFrom).find(
        ([k]) =>
          k.toLowerCase() === dbName.toLowerCase() ||
          k.toLowerCase() === dbId.toLowerCase()
      )?.[1]
    : undefined;

  if (!dbIncluded && !cherryPickList) {
    return [];
  }

  let collections: Models.Collection[];

  if (!dbIncluded && cherryPickList) {
    // Excluded DB with cherry-picks — fetch individually to avoid listing all
    collections = [];
    for (const pickId of cherryPickList) {
      try {
        const coll = await database.getCollection(dbId, pickId);
        collections.push(coll);
      } catch {
        MessageFormatter.warning(
          `Cherry-pick "${pickId}" not found as collection ID in ${dbName} — skipping`,
          { prefix: "Filter" }
        );
      }
    }
  } else {
    // Included DB — fetch all, then filter
    collections = await fetchAllCollections(dbId, database);
    collections = collections.filter((coll) =>
      ConstantsGenerator.shouldInclude(
        coll.name,
        coll.$id,
        filter.collections
      )
    );
  }

  return collections;
}

/**
 * Filter a list of buckets.
 */
export function filterBuckets(
  buckets: Models.Bucket[],
  filter?: ConstantsFilterConfig
): Models.Bucket[] {
  if (!filter) return buckets;
  return buckets.filter((b) =>
    ConstantsGenerator.shouldInclude(b.name, b.$id, filter.buckets)
  );
}
