import { Query } from "node-appwrite";
import yaml from "js-yaml";
import fs from "node:fs";
import path from "node:path";
import inquirer from "inquirer";
import chalk from "chalk";
import pLimit from "p-limit";
import {
  type DatabaseAdapter,
  MessageFormatter,
  tryAwaitWithRetry,
} from "@njdamstra/appwrite-utils-helpers";
import type { AppwriteConfig } from "@njdamstra/appwrite-utils";
import { ProgressManager } from "../shared/progressManager.js";
import {
  type MigrationPlan,
  type MigrationPlanEntry,
  type MigrationCheckpoint,
  type CheckpointEntry,
  type CheckpointPhase,
  type AnalyzeOptions,
  type ExecuteOptions,
  MigrationPlanSchema,
  MigrationCheckpointSchema,
  suggestTargetType,
  generateBackupKey,
} from "./migrateStringsTypes.js";

// ────────────────────────────────────────────────────────
// Phase 1: Analyze — queries Appwrite server for real state
// ────────────────────────────────────────────────────────

export async function analyzeStringAttributes(
  adapter: DatabaseAdapter,
  config: AppwriteConfig,
  options: AnalyzeOptions = {}
): Promise<MigrationPlan> {
  let databasesToScan = config.databases || [];
  if (options.databaseIds?.length) {
    databasesToScan = databasesToScan.filter(db => options.databaseIds!.includes(db.$id));
  }
  const databases = databasesToScan;
  if (databases.length === 0) {
    MessageFormatter.warning("No databases configured. Nothing to analyze.", {
      prefix: "Analyze",
    });
    return emptyPlan(config);
  }

  const entries: MigrationPlanEntry[] = [];

  for (const db of databases) {
    MessageFormatter.info(`Scanning database: ${db.name} (${db.$id})`, {
      prefix: "Analyze",
    });

    // Fetch all collections/tables from server
    const tablesRes = await tryAwaitWithRetry(() =>
      adapter.listTables({ databaseId: db.$id })
    );
    const tables: any[] =
      tablesRes?.tables || tablesRes?.collections || tablesRes?.data || [];

    for (const table of tables) {
      const tableId: string = table.$id || table.key || table.name;
      const tableName: string = table.name || tableId;

      // Fetch full schema from server
      const schemaRes = await tryAwaitWithRetry(() =>
        adapter.getTable({ databaseId: db.$id, tableId })
      );
      const attributes: any[] =
        schemaRes?.data?.columns || schemaRes?.data?.attributes || [];

      // Fetch indexes from server
      const indexRes = await tryAwaitWithRetry(() =>
        adapter.listIndexes({ databaseId: db.$id, tableId })
      );
      const indexes: any[] = indexRes?.data || [];

      for (const attr of attributes) {
        if (attr.type !== "string") continue;

        const size: number = attr.size || 50;
        const isEncrypted = !!(attr as any).encrypt;
        const isRequired = !!attr.required;
        const isArray = !!attr.array;
        const hasDefault =
          attr.xdefault !== undefined && attr.xdefault !== null;

        // Find indexes that reference this attribute
        const affectedIndexes = indexes
          .filter((idx: any) => idx.attributes?.includes(attr.key))
          .map((idx: any) => idx.key);
        const hasIndex = affectedIndexes.length > 0;

        const suggested = suggestTargetType(size, hasIndex);

        const entry: MigrationPlanEntry = {
          databaseId: db.$id,
          databaseName: db.name,
          collectionId: tableId,
          collectionName: tableName,
          attributeKey: attr.key,
          currentType: "string",
          currentSize: size,
          isRequired,
          isArray,
          isEncrypted,
          hasDefault,
          defaultValue: hasDefault ? attr.xdefault : undefined,
          suggestedType: suggested,
          targetType: suggested,
          targetSize: suggested === "varchar" ? size : undefined,
          action: isEncrypted ? "skip" : "migrate",
          skipReason: isEncrypted ? "encrypted" : undefined,
          indexesAffected: affectedIndexes,
        };

        // Indexed attrs must stay varchar
        if (hasIndex && suggested !== "varchar" && !isEncrypted) {
          entry.targetType = "varchar";
          entry.targetSize = size;
        }

        entries.push(entry);
      }
    }
  }

  const toMigrate = entries.filter((e) => e.action === "migrate").length;
  const toSkip = entries.filter((e) => e.action === "skip").length;
  const uniqueDbs = new Set(entries.map((e) => e.databaseId));
  const uniqueColls = new Set(
    entries.map((e) => `${e.databaseId}:${e.collectionId}`)
  );

  const plan: MigrationPlan = {
    version: 1,
    generatedAt: new Date().toISOString(),
    appwriteEndpoint: config.appwriteEndpoint,
    appwriteProject: config.appwriteProject,
    summary: {
      totalStringAttributes: entries.length,
      toMigrate,
      toSkip,
      databaseCount: uniqueDbs.size,
      collectionCount: uniqueColls.size,
    },
    entries,
  };

  // Write YAML plan
  const outputPath =
    options.outputPath || path.join(process.cwd(), "migrate-strings-plan.yaml");
  const yamlContent = yaml.dump(plan, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });
  fs.writeFileSync(outputPath, yamlContent, "utf8");

  // Print summary
  MessageFormatter.info(`Migration plan written to ${outputPath}`, {
    prefix: "Analyze",
  });
  printPlanSummary(plan);

  return plan;
}

function emptyPlan(config: AppwriteConfig): MigrationPlan {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    appwriteEndpoint: config.appwriteEndpoint,
    appwriteProject: config.appwriteProject,
    summary: {
      totalStringAttributes: 0,
      toMigrate: 0,
      toSkip: 0,
      databaseCount: 0,
      collectionCount: 0,
    },
    entries: [],
  };
}

function printPlanSummary(plan: MigrationPlan): void {
  const { summary } = plan;
  console.log("");
  console.log(chalk.bold("String Attribute Migration Plan Summary"));
  console.log(chalk.gray("─".repeat(50)));
  console.log(
    `  Total string attributes: ${chalk.yellow(summary.totalStringAttributes)}`
  );
  console.log(`  To migrate:             ${chalk.green(summary.toMigrate)}`);
  console.log(`  To skip:                ${chalk.red(summary.toSkip)}`);
  console.log(`  Databases:              ${summary.databaseCount}`);
  console.log(`  Collections:            ${summary.collectionCount}`);
  console.log("");

  // Type distribution
  const typeDistribution: Record<string, number> = {};
  for (const entry of plan.entries) {
    if (entry.action === "migrate") {
      typeDistribution[entry.targetType] =
        (typeDistribution[entry.targetType] || 0) + 1;
    }
  }
  if (Object.keys(typeDistribution).length > 0) {
    console.log(chalk.bold("  Target type distribution:"));
    for (const [type, count] of Object.entries(typeDistribution)) {
      console.log(`    ${type}: ${count}`);
    }
    console.log("");
  }

  // Skipped reasons
  const skipReasons: Record<string, number> = {};
  for (const entry of plan.entries) {
    if (entry.action === "skip" && entry.skipReason) {
      skipReasons[entry.skipReason] =
        (skipReasons[entry.skipReason] || 0) + 1;
    }
  }
  if (Object.keys(skipReasons).length > 0) {
    console.log(chalk.bold("  Skip reasons:"));
    for (const [reason, count] of Object.entries(skipReasons)) {
      console.log(`    ${reason}: ${count}`);
    }
    console.log("");
  }

  console.log(
    chalk.dim(
      "  Edit the YAML plan file to change targetType or action before executing."
    )
  );
  console.log("");
}

// ────────────────────────────────────────────────────────
// Phase 2: Execute — server connection required
// ────────────────────────────────────────────────────────

export async function executeMigrationPlan(
  adapter: DatabaseAdapter,
  options: ExecuteOptions
): Promise<{ succeeded: number; failed: number; skipped: number }> {
  // Load and validate plan
  const planYaml = fs.readFileSync(options.planPath, "utf8");
  const planRaw = yaml.load(planYaml);
  const plan = MigrationPlanSchema.parse(planRaw);

  const migrateEntries = plan.entries.filter((e) => e.action === "migrate");
  if (migrateEntries.length === 0) {
    MessageFormatter.info("No attributes to migrate in plan.", {
      prefix: "Execute",
    });
    return { succeeded: 0, failed: 0, skipped: plan.entries.length };
  }

  // Load or create checkpoint
  const checkpointPath =
    options.checkpointPath ||
    options.planPath.replace(/\.ya?ml$/, ".checkpoint.json");
  if (options.freshRun && fs.existsSync(checkpointPath)) {
    fs.unlinkSync(checkpointPath);
    MessageFormatter.info("Deleted old checkpoint — starting fresh.", {
      prefix: "Checkpoint",
    });
  }
  const checkpoint = loadOrCreateCheckpoint(checkpointPath, options.planPath);

  const batchSize = options.batchSize || 100;
  const batchDelayMs = options.batchDelayMs || 50;

  // Group by database/collection
  const groups = new Map<string, MigrationPlanEntry[]>();
  for (const entry of migrateEntries) {
    const key = `${entry.databaseId}:${entry.collectionId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(entry);
  }

  let succeeded = 0;
  let failed = 0;
  let skipped = plan.entries.filter((e) => e.action === "skip").length;

  MessageFormatter.info(
    `Executing migration: ${migrateEntries.length} attributes across ${groups.size} collections`,
    { prefix: "Execute" }
  );

  if (options.dryRun) {
    MessageFormatter.info("DRY RUN — no changes will be made", {
      prefix: "Execute",
    });
    printDryRunSummary(plan);
    return { succeeded: 0, failed: 0, skipped: plan.entries.length };
  }

  for (const [groupKey, entries] of groups) {
    const first = entries[0];
    console.log("");
    console.log(
      chalk.bold(
        `Collection: ${first.collectionName} (${first.databaseName}/${first.collectionId})`
      )
    );
    console.log(
      `  Attributes to migrate: ${entries.map((e) => e.attributeKey).join(", ")}`
    );

    // Per-collection confirmation
    const { proceed } = await inquirer.prompt([
      {
        type: "list",
        name: "proceed",
        message: `Migrate ${entries.length} attribute(s) in ${first.collectionName}?`,
        choices: [
          { name: "Yes, proceed", value: "yes" },
          { name: "Skip this collection", value: "skip" },
          { name: "Abort entire migration", value: "abort" },
        ],
      },
    ]);

    if (proceed === "abort") {
      MessageFormatter.info("Migration aborted by user.", {
        prefix: "Execute",
      });
      break;
    }
    if (proceed === "skip") {
      skipped += entries.length;
      continue;
    }

    // Migrate each attribute in this collection
    for (const entry of entries) {
      const cpEntry = getOrCreateCheckpointEntry(checkpoint, entry);

      if (cpEntry.phase === "completed") {
        MessageFormatter.info(
          `  ${entry.attributeKey}: already completed (checkpoint)`,
          { prefix: "Execute" }
        );
        succeeded++;
        continue;
      }

      try {
        await migrateOneAttribute(
          adapter,
          entry,
          cpEntry,
          checkpoint,
          checkpointPath,
          {
            batchSize,
            batchDelayMs,
            keepBackups: options.keepBackups ?? true,
          }
        );
        succeeded++;
        MessageFormatter.success(
          `  ${entry.attributeKey}: migrated to ${entry.targetType}`,
          { prefix: "Execute" }
        );
      } catch (err: any) {
        failed++;
        cpEntry.phase = "failed";
        cpEntry.error = err.message || String(err);
        saveCheckpoint(checkpoint, checkpointPath);
        MessageFormatter.error(
          `  ${entry.attributeKey}: FAILED — ${cpEntry.error}`,
          undefined,
          { prefix: "Execute" }
        );
      }
    }

    // After collection completes, offer to update local YAML
    const successInGroup = entries.filter((e) => {
      const cp = findCheckpointEntry(checkpoint, e);
      return cp?.phase === "completed";
    }).length;

    if (successInGroup > 0) {
      const { updateYaml } = await inquirer.prompt([
        {
          type: "confirm",
          name: "updateYaml",
          message: `Update local YAML config for ${first.collectionName}? (change type: string → new types)`,
          default: false,
        },
      ]);
      if (updateYaml) {
        await updateCollectionYaml(first.collectionName, entries, checkpoint);
      }
    }
  }

  // Final summary
  console.log("");
  console.log(chalk.bold("Migration Results"));
  console.log(chalk.gray("─".repeat(40)));
  console.log(`  Succeeded: ${chalk.green(succeeded)}`);
  console.log(`  Failed:    ${chalk.red(failed)}`);
  console.log(`  Skipped:   ${chalk.yellow(skipped)}`);
  console.log("");

  if (failed > 0) {
    MessageFormatter.info(
      `Checkpoint saved at ${checkpointPath} — rerun to resume failed attributes.`,
      { prefix: "Execute" }
    );
  }

  return { succeeded, failed, skipped };
}

// ────────────────────────────────────────────────────────
// Single attribute migration (9 phases)
// ────────────────────────────────────────────────────────

interface MigrateOneOptions {
  batchSize: number;
  batchDelayMs: number;
  keepBackups: boolean;
}

async function migrateOneAttribute(
  adapter: DatabaseAdapter,
  entry: MigrationPlanEntry,
  cpEntry: CheckpointEntry,
  checkpoint: MigrationCheckpoint,
  checkpointPath: string,
  opts: MigrateOneOptions
): Promise<void> {
  const { databaseId, collectionId, attributeKey, targetType, targetSize } =
    entry;
  const backupKey = cpEntry.backupKey;

  const advance = (phase: CheckpointPhase) => {
    cpEntry.phase = phase;
    checkpoint.lastUpdatedAt = new Date().toISOString();
    saveCheckpoint(checkpoint, checkpointPath);
  };

  // Step 1: Create backup attribute
  if (phaseIndex(cpEntry.phase) < phaseIndex("backup_created")) {
    MessageFormatter.info(`    Creating backup attribute ${backupKey}...`, {
      prefix: "Migrate",
    });
    await createAttributeIfNotExists(adapter, {
      databaseId,
      tableId: collectionId,
      key: backupKey,
      type: "string", // backup keeps original type
      size: entry.currentSize,
      required: false, // always optional for backup
      array: entry.isArray,
    });
    const available = await waitForAttribute(
      adapter,
      databaseId,
      collectionId,
      backupKey
    );
    if (!available) throw new Error(`Backup attribute ${backupKey} stuck`);
    advance("backup_created");
  }

  // Step 2: Copy data to backup
  if (phaseIndex(cpEntry.phase) < phaseIndex("data_copied_to_backup")) {
    MessageFormatter.info(`    Copying data to backup ${backupKey}...`, {
      prefix: "Migrate",
    });
    await copyAttributeData(
      adapter,
      databaseId,
      collectionId,
      attributeKey,
      backupKey,
      opts.batchSize,
      opts.batchDelayMs
    );
    advance("data_copied_to_backup");
  }

  // Step 3: Verify backup
  if (phaseIndex(cpEntry.phase) < phaseIndex("data_verified_backup")) {
    await verifyDataCopy(
      adapter,
      databaseId,
      collectionId,
      attributeKey,
      backupKey
    );
    advance("data_verified_backup");
  }

  // Step 4: Delete indexes + original attribute
  if (phaseIndex(cpEntry.phase) < phaseIndex("original_deleted")) {
    // Save and delete affected indexes
    if (entry.indexesAffected.length > 0) {
      MessageFormatter.info(`    Removing ${entry.indexesAffected.length} affected index(es)...`, {
        prefix: "Migrate",
      });
      await saveAndDeleteIndexes(
        adapter,
        databaseId,
        collectionId,
        entry.indexesAffected,
        cpEntry
      );
      saveCheckpoint(checkpoint, checkpointPath);
    }

    MessageFormatter.info(`    Deleting original attribute ${attributeKey}...`, {
      prefix: "Migrate",
    });
    await tryAwaitWithRetry(() =>
      adapter.deleteAttribute({
        databaseId,
        tableId: collectionId,
        key: attributeKey,
      })
    );
    await waitForAttributeGone(adapter, databaseId, collectionId, attributeKey);
    advance("original_deleted");
  }

  // Step 5: Create new attribute with target type
  if (phaseIndex(cpEntry.phase) < phaseIndex("new_attr_created")) {
    MessageFormatter.info(
      `    Creating new attribute ${attributeKey} as ${targetType}...`,
      { prefix: "Migrate" }
    );
    const createParams: Record<string, any> = {
      databaseId,
      tableId: collectionId,
      key: attributeKey,
      type: targetType,
      required: false, // create as optional first — data needs to be copied back
      array: entry.isArray,
    };
    if (targetType === "varchar" && targetSize) {
      createParams.size = targetSize;
    }
    if (entry.hasDefault && entry.defaultValue !== undefined) {
      createParams.default = entry.defaultValue;
    }

    await createAttributeIfNotExists(adapter, createParams as any);
    const available = await waitForAttribute(
      adapter,
      databaseId,
      collectionId,
      attributeKey
    );
    if (!available)
      throw new Error(`New attribute ${attributeKey} stuck after creation`);
    advance("new_attr_created");
  }

  // Step 6: Copy data back from backup
  if (phaseIndex(cpEntry.phase) < phaseIndex("data_copied_back")) {
    MessageFormatter.info(`    Copying data back from backup...`, {
      prefix: "Migrate",
    });
    await copyAttributeData(
      adapter,
      databaseId,
      collectionId,
      backupKey,
      attributeKey,
      opts.batchSize,
      opts.batchDelayMs
    );
    advance("data_copied_back");
  }

  // Step 7: Verify final data
  if (phaseIndex(cpEntry.phase) < phaseIndex("data_verified_final")) {
    await verifyDataCopy(
      adapter,
      databaseId,
      collectionId,
      backupKey,
      attributeKey
    );
    advance("data_verified_final");
  }

  // Step 8: Recreate indexes + delete backup
  if (phaseIndex(cpEntry.phase) < phaseIndex("backup_deleted")) {
    // Recreate indexes
    if (cpEntry.storedIndexes.length > 0) {
      MessageFormatter.info(
        `    Recreating ${cpEntry.storedIndexes.length} index(es)...`,
        { prefix: "Migrate" }
      );
      await recreateIndexes(adapter, databaseId, collectionId, cpEntry);
    }

    // Delete backup (unless keepBackups)
    if (!opts.keepBackups) {
      MessageFormatter.info(`    Deleting backup attribute ${backupKey}...`, {
        prefix: "Migrate",
      });
      await tryAwaitWithRetry(() =>
        adapter.deleteAttribute({
          databaseId,
          tableId: collectionId,
          key: backupKey,
        })
      );
      await waitForAttributeGone(
        adapter,
        databaseId,
        collectionId,
        backupKey
      );
    }
    advance("backup_deleted");
  }

  // Step 9: Mark completed
  // If the original attribute was required, update it now (after data is in place)
  if (entry.isRequired) {
    try {
      await tryAwaitWithRetry(() =>
        adapter.updateAttribute({
          databaseId,
          tableId: collectionId,
          key: attributeKey,
          required: true,
        } as any)
      );
    } catch {
      // Non-fatal — attribute is migrated, just not set back to required
      MessageFormatter.info(
        `    Warning: could not set ${attributeKey} back to required`,
        { prefix: "Migrate" }
      );
    }
  }
  advance("completed");
}

// ────────────────────────────────────────────────────────
// Helper: copy attribute data via cursor pagination
// ────────────────────────────────────────────────────────

async function copyAttributeData(
  adapter: DatabaseAdapter,
  databaseId: string,
  collectionId: string,
  sourceKey: string,
  targetKey: string,
  batchSize: number,
  batchDelayMs: number
): Promise<void> {
  let lastId: string | undefined;
  let totalCopied = 0;
  let totalDocs: number | undefined;

  // Get initial count
  const countRes = await tryAwaitWithRetry(() =>
    adapter.listRows({
      databaseId,
      tableId: collectionId,
      queries: [Query.limit(1)],
    })
  );
  totalDocs = countRes?.total ?? undefined;
  const progress = totalDocs
    ? ProgressManager.create(`copy-${sourceKey}-${targetKey}`, totalDocs, {
        title: `    Copy ${sourceKey} → ${targetKey}`,
      })
    : undefined;

  const limit = pLimit(5);

  while (true) {
    const queries: string[] = [Query.limit(batchSize)];
    if (lastId) queries.push(Query.cursorAfter(lastId));

    const res = await tryAwaitWithRetry(() =>
      adapter.listRows({ databaseId, tableId: collectionId, queries })
    );

    const docs = res?.documents || res?.rows || [];
    if (docs.length === 0) break;

    // Partial update: copy sourceKey → targetKey using updateRow (not bulkUpsert
    // which requires complete document structure and fails on partial payloads)
    const updatePromises = docs
      .filter((d: any) => d[sourceKey] !== undefined)
      .map((d: any) =>
        limit(() =>
          tryAwaitWithRetry(
            () =>
              adapter.updateRow({
                databaseId,
                tableId: collectionId,
                id: d.$id,
                data: { [targetKey]: d[sourceKey] },
              }),
            0,
            true // throwError — surface 400s immediately
          )
        )
      );
    await Promise.all(updatePromises);

    totalCopied += docs.length;
    lastId = docs[docs.length - 1].$id;
    progress?.update(totalCopied);

    if (docs.length < batchSize) break; // last page
    if (batchDelayMs > 0) await delay(batchDelayMs);
  }

  progress?.stop();
}

// ────────────────────────────────────────────────────────
// Helper: verify data copy (count + spot check)
// ────────────────────────────────────────────────────────

async function verifyDataCopy(
  adapter: DatabaseAdapter,
  databaseId: string,
  collectionId: string,
  sourceKey: string,
  targetKey: string
): Promise<void> {
  // Spot-check first 5 documents
  const res = await tryAwaitWithRetry(() =>
    adapter.listRows({
      databaseId,
      tableId: collectionId,
      queries: [Query.limit(5)],
    })
  );
  const docs = res?.documents || res?.rows || [];
  for (const doc of docs) {
    if (!(sourceKey in doc)) continue;
    if (JSON.stringify(doc[sourceKey]) !== JSON.stringify(doc[targetKey])) {
      throw new Error(
        `Verification failed: doc ${doc.$id} has ${sourceKey}=${JSON.stringify(doc[sourceKey])} but ${targetKey}=${JSON.stringify(doc[targetKey])}`
      );
    }
  }
}

// ────────────────────────────────────────────────────────
// Helper: wait for attribute to become available
// ────────────────────────────────────────────────────────

async function waitForAttribute(
  adapter: DatabaseAdapter,
  databaseId: string,
  collectionId: string,
  key: string,
  maxWaitMs: number = 120_000
): Promise<boolean> {
  const start = Date.now();
  const checkInterval = 2000;

  while (Date.now() - start < maxWaitMs) {
    const res = await tryAwaitWithRetry(() =>
      adapter.getTable({ databaseId, tableId: collectionId })
    );
    const attrs: any[] =
      res?.data?.attributes || res?.data?.columns || [];
    const attr = attrs.find((a: any) => a.key === key);
    if (attr) {
      if (attr.status === "available") return true;
      if (attr.status === "failed" || attr.status === "stuck") return false;
    }
    await delay(checkInterval);
  }
  return false;
}

// ────────────────────────────────────────────────────────
// Helper: wait for attribute to be fully deleted
// ────────────────────────────────────────────────────────

async function waitForAttributeGone(
  adapter: DatabaseAdapter,
  databaseId: string,
  collectionId: string,
  key: string,
  maxWaitMs: number = 60_000
): Promise<boolean> {
  const start = Date.now();
  const checkInterval = 2000;

  while (Date.now() - start < maxWaitMs) {
    const res = await tryAwaitWithRetry(() =>
      adapter.getTable({ databaseId, tableId: collectionId })
    );
    const attrs: any[] =
      res?.data?.attributes || res?.data?.columns || [];
    const attr = attrs.find((a: any) => a.key === key);
    if (!attr) return true;
    if (attr.status === "deleting") {
      await delay(checkInterval);
      continue;
    }
    // Still present and not deleting — wait
    await delay(checkInterval);
  }
  return false;
}

// ────────────────────────────────────────────────────────
// Helper: index management
// ────────────────────────────────────────────────────────

async function saveAndDeleteIndexes(
  adapter: DatabaseAdapter,
  databaseId: string,
  collectionId: string,
  indexKeys: string[],
  cpEntry: CheckpointEntry
): Promise<void> {
  // Fetch current indexes from server
  const res = await tryAwaitWithRetry(() =>
    adapter.listIndexes({ databaseId, tableId: collectionId })
  );
  const allIndexes: any[] = res?.data || [];

  for (const idxKey of indexKeys) {
    const idx = allIndexes.find((i: any) => i.key === idxKey);
    if (!idx) continue;

    // Store definition for recreation
    const alreadyStored = cpEntry.storedIndexes.some(
      (s) => s.key === idxKey
    );
    if (!alreadyStored) {
      cpEntry.storedIndexes.push({
        key: idx.key,
        type: idx.type || "key",
        attributes: idx.attributes || [],
        orders: idx.orders,
      });
    }

    // Delete
    await tryAwaitWithRetry(() =>
      adapter.deleteIndex({ databaseId, tableId: collectionId, key: idxKey })
    );
  }

  // Wait for indexes to be gone
  for (const idxKey of indexKeys) {
    await waitForIndexGone(adapter, databaseId, collectionId, idxKey);
  }
}

async function recreateIndexes(
  adapter: DatabaseAdapter,
  databaseId: string,
  collectionId: string,
  cpEntry: CheckpointEntry
): Promise<void> {
  for (const idx of cpEntry.storedIndexes) {
    await tryAwaitWithRetry(() =>
      adapter.createIndex({
        databaseId,
        tableId: collectionId,
        key: idx.key,
        type: idx.type as any,
        attributes: idx.attributes,
        orders: idx.orders,
      })
    );
    // Wait for index to become available
    await waitForIndexAvailable(adapter, databaseId, collectionId, idx.key);
  }
}

async function waitForIndexGone(
  adapter: DatabaseAdapter,
  databaseId: string,
  collectionId: string,
  key: string,
  maxWaitMs: number = 60_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await tryAwaitWithRetry(() =>
      adapter.listIndexes({ databaseId, tableId: collectionId })
    );
    const indexes: any[] = res?.data || [];
    if (!indexes.find((i: any) => i.key === key)) return;
    await delay(2000);
  }
}

async function waitForIndexAvailable(
  adapter: DatabaseAdapter,
  databaseId: string,
  collectionId: string,
  key: string,
  maxWaitMs: number = 60_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await tryAwaitWithRetry(() =>
      adapter.listIndexes({ databaseId, tableId: collectionId })
    );
    const indexes: any[] = res?.data || [];
    const idx = indexes.find((i: any) => i.key === key);
    if (idx?.status === "available") return;
    if (idx?.status === "failed") {
      throw new Error(`Index ${key} creation failed`);
    }
    await delay(2000);
  }
}

// ────────────────────────────────────────────────────────
// Checkpoint management
// ────────────────────────────────────────────────────────

function loadOrCreateCheckpoint(
  checkpointPath: string,
  planFile: string
): MigrationCheckpoint {
  if (fs.existsSync(checkpointPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
      const parsed = MigrationCheckpointSchema.parse(raw);
      MessageFormatter.info(
        `Resuming from checkpoint: ${checkpointPath}`,
        { prefix: "Checkpoint" }
      );
      return parsed;
    } catch {
      MessageFormatter.info(
        "Corrupt checkpoint file, creating new one.",
        { prefix: "Checkpoint" }
      );
    }
  }

  const now = new Date().toISOString();
  return {
    planFile,
    startedAt: now,
    lastUpdatedAt: now,
    entries: [],
  };
}

function saveCheckpoint(
  checkpoint: MigrationCheckpoint,
  checkpointPath: string
): void {
  checkpoint.lastUpdatedAt = new Date().toISOString();
  fs.writeFileSync(
    checkpointPath,
    JSON.stringify(checkpoint, null, 2),
    "utf8"
  );
}

function getOrCreateCheckpointEntry(
  checkpoint: MigrationCheckpoint,
  entry: MigrationPlanEntry
): CheckpointEntry {
  const existing = findCheckpointEntry(checkpoint, entry);
  if (existing) return existing;

  const cpEntry: CheckpointEntry = {
    databaseId: entry.databaseId,
    collectionId: entry.collectionId,
    attributeKey: entry.attributeKey,
    backupKey: generateBackupKey(entry.attributeKey),
    phase: "pending",
    targetType: entry.targetType,
    targetSize: entry.targetSize,
    storedIndexes: [],
  };
  checkpoint.entries.push(cpEntry);
  return cpEntry;
}

function findCheckpointEntry(
  checkpoint: MigrationCheckpoint,
  entry: MigrationPlanEntry
): CheckpointEntry | undefined {
  return checkpoint.entries.find(
    (e) =>
      e.databaseId === entry.databaseId &&
      e.collectionId === entry.collectionId &&
      e.attributeKey === entry.attributeKey
  );
}

// ────────────────────────────────────────────────────────
// Phase ordering for checkpoint resume
// ────────────────────────────────────────────────────────

const PHASE_ORDER: CheckpointPhase[] = [
  "pending",
  "backup_created",
  "data_copied_to_backup",
  "data_verified_backup",
  "original_deleted",
  "new_attr_created",
  "data_copied_back",
  "data_verified_final",
  "backup_deleted",
  "completed",
];

function phaseIndex(phase: CheckpointPhase): number {
  const idx = PHASE_ORDER.indexOf(phase);
  return idx >= 0 ? idx : -1;
}

// ────────────────────────────────────────────────────────
// Dry run summary
// ────────────────────────────────────────────────────────

function printDryRunSummary(plan: MigrationPlan): void {
  console.log("");
  console.log(chalk.bold("Dry Run — What Would Happen:"));
  console.log(chalk.gray("─".repeat(50)));

  const groups = new Map<string, MigrationPlanEntry[]>();
  for (const entry of plan.entries) {
    if (entry.action !== "migrate") continue;
    const key = `${entry.databaseName}/${entry.collectionName}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(entry);
  }

  for (const [groupName, entries] of groups) {
    console.log(`\n  ${chalk.cyan(groupName)}`);
    for (const e of entries) {
      const sizeInfo =
        e.targetType === "varchar" ? ` (size: ${e.targetSize})` : "";
      const indexInfo =
        e.indexesAffected.length > 0
          ? ` [indexes: ${e.indexesAffected.join(", ")}]`
          : "";
      console.log(
        `    ${e.attributeKey}: string(${e.currentSize}) → ${e.targetType}${sizeInfo}${indexInfo}`
      );
    }
  }

  const skipped = plan.entries.filter((e) => e.action === "skip");
  if (skipped.length > 0) {
    console.log(`\n  ${chalk.yellow("Skipped:")}`);
    for (const e of skipped) {
      console.log(`    ${e.attributeKey}: ${e.skipReason || "manual skip"}`);
    }
  }
  console.log("");
}

// ────────────────────────────────────────────────────────
// Update local collection YAML after migration
// ────────────────────────────────────────────────────────

async function updateCollectionYaml(
  collectionName: string,
  entries: MigrationPlanEntry[],
  checkpoint: MigrationCheckpoint
): Promise<void> {
  // Find candidate YAML files
  const candidates = findYamlFiles(process.cwd(), collectionName);

  if (candidates.length === 0) {
    MessageFormatter.warning(
      `No YAML file found for collection "${collectionName}". Skipping local config update.`,
      { prefix: "YAML" }
    );
    return;
  }

  let yamlPath: string;

  if (candidates.length === 1) {
    const { usePath } = await inquirer.prompt([
      {
        type: "confirm",
        name: "usePath",
        message: `Found: ${candidates[0]}. Use this file?`,
        default: true,
      },
    ]);
    if (!usePath) {
      const { customPath } = await inquirer.prompt([
        {
          type: "input",
          name: "customPath",
          message: "Enter path to collection YAML file:",
        },
      ]);
      if (!customPath || !fs.existsSync(customPath)) {
        MessageFormatter.warning("Invalid path. Skipping YAML update.", {
          prefix: "YAML",
        });
        return;
      }
      yamlPath = customPath;
    } else {
      yamlPath = candidates[0];
    }
  } else {
    const { selectedPath } = await inquirer.prompt([
      {
        type: "list",
        name: "selectedPath",
        message: `Multiple YAML files found for "${collectionName}". Select one:`,
        choices: [
          ...candidates.map((c) => ({ name: c, value: c })),
          { name: "Enter custom path", value: "__custom__" },
        ],
      },
    ]);
    if (selectedPath === "__custom__") {
      const { customPath } = await inquirer.prompt([
        {
          type: "input",
          name: "customPath",
          message: "Enter path to collection YAML file:",
        },
      ]);
      if (!customPath || !fs.existsSync(customPath)) {
        MessageFormatter.warning("Invalid path. Skipping YAML update.", {
          prefix: "YAML",
        });
        return;
      }
      yamlPath = customPath;
    } else {
      yamlPath = selectedPath;
    }
  }

  // Load and parse YAML
  let doc: any;
  try {
    const content = fs.readFileSync(yamlPath, "utf8");
    doc = yaml.load(content);
  } catch (err: any) {
    MessageFormatter.error(
      `Failed to parse ${yamlPath}: ${err.message}`,
      undefined,
      { prefix: "YAML" }
    );
    return;
  }

  if (!doc || !Array.isArray(doc.attributes)) {
    MessageFormatter.warning(
      `No "attributes" array found in ${yamlPath}. Skipping.`,
      { prefix: "YAML" }
    );
    return;
  }

  // Update attributes that were successfully migrated
  let updated = 0;
  for (const entry of entries) {
    const cp = findCheckpointEntry(checkpoint, entry);
    if (cp?.phase !== "completed") continue;

    const attr = doc.attributes.find(
      (a: any) => a.key === entry.attributeKey && a.type === "string"
    );
    if (!attr) continue;

    attr.type = entry.targetType;
    if (entry.targetType !== "varchar") {
      delete attr.size;
    }
    updated++;
  }

  if (updated === 0) {
    MessageFormatter.info(
      "No matching string attributes found in YAML to update.",
      { prefix: "YAML" }
    );
    return;
  }

  // Write back
  try {
    const output = yaml.dump(doc, {
      lineWidth: 120,
      noRefs: true,
      sortKeys: false,
    });
    fs.writeFileSync(yamlPath, output, "utf8");
    MessageFormatter.success(
      `Updated ${updated} attribute(s) in ${yamlPath}`,
      { prefix: "YAML" }
    );
  } catch (err: any) {
    MessageFormatter.error(
      `Failed to write ${yamlPath}: ${err.message}`,
      undefined,
      { prefix: "YAML" }
    );
  }
}

function findYamlFiles(searchRoot: string, collectionName: string): string[] {
  const results: string[] = [];
  const lowerName = collectionName.toLowerCase();

  function walk(dir: string): void {
    let dirEntries: fs.Dirent[];
    try {
      dirEntries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // skip inaccessible directories
    }
    for (const ent of dirEntries) {
      const fullPath = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // Skip node_modules, .git, and other common non-config dirs
        if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "dist") continue;
        walk(fullPath);
      } else if (
        ent.isFile() &&
        ent.name.toLowerCase() === `${lowerName}.yaml`
      ) {
        // Verify it looks like a collection config (has a name field)
        try {
          const content = fs.readFileSync(fullPath, "utf8");
          const parsed = yaml.load(content) as any;
          if (parsed && parsed.name === collectionName) {
            results.push(fullPath);
          }
        } catch {
          // skip unparseable files
        }
      }
    }
  }

  walk(searchRoot);
  return results;
}

// ────────────────────────────────────────────────────────
// Utility
// ────────────────────────────────────────────────────────

async function createAttributeIfNotExists(
  adapter: DatabaseAdapter,
  params: Parameters<DatabaseAdapter["createAttribute"]>[0]
): Promise<void> {
  try {
    await tryAwaitWithRetry(() => adapter.createAttribute(params), 0, true);
  } catch (err: any) {
    const code = err?.code || err?.originalError?.code;
    const type = err?.originalError?.type || "";
    if (code === 409 || type === "column_already_exists") {
      MessageFormatter.info(`      (backup attribute already exists, reusing)`, {
        prefix: "Migrate",
      });
      return;
    }
    throw err;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
