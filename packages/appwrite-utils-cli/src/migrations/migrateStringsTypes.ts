import { z } from "zod";

// ── Target types for string attribute migration ──

export const MigrationTargetType = z.enum([
  "varchar",
  "text",
  "mediumtext",
  "longtext",
]);
export type MigrationTargetType = z.infer<typeof MigrationTargetType>;

export const MigrationAction = z.enum(["migrate", "skip"]);
export type MigrationAction = z.infer<typeof MigrationAction>;

// ── Plan entry: one per attribute to migrate ──

export const MigrationPlanEntrySchema = z.object({
  databaseId: z.string(),
  databaseName: z.string(),
  collectionId: z.string(),
  collectionName: z.string(),
  attributeKey: z.string(),
  currentType: z.string().default("string"),
  currentSize: z.number(),
  isRequired: z.boolean().default(false),
  isArray: z.boolean().default(false),
  isEncrypted: z.boolean().default(false),
  hasDefault: z.boolean().default(false),
  defaultValue: z.any().optional(),
  suggestedType: MigrationTargetType,
  targetType: MigrationTargetType,
  targetSize: z.number().optional(), // varchar only
  action: MigrationAction,
  skipReason: z.string().optional(),
  indexesAffected: z.array(z.string()).default([]),
});
export type MigrationPlanEntry = z.infer<typeof MigrationPlanEntrySchema>;

// ── Plan: full migration plan (user-editable YAML) ──

export const MigrationPlanSchema = z.object({
  version: z.number().default(1),
  generatedAt: z.string(),
  appwriteEndpoint: z.string().optional(),
  appwriteProject: z.string().optional(),
  summary: z.object({
    totalStringAttributes: z.number(),
    toMigrate: z.number(),
    toSkip: z.number(),
    databaseCount: z.number(),
    collectionCount: z.number(),
  }),
  entries: z.array(MigrationPlanEntrySchema),
});
export type MigrationPlan = z.infer<typeof MigrationPlanSchema>;

// ── Checkpoint: tracks progress during execution ──

export const CheckpointPhase = z.enum([
  "pending",
  "backup_created",
  "data_copied_to_backup",
  "data_verified_backup",
  "original_cleared",
  "backup_renamed",
  "indexes_recreated",
  "completed",
  "failed",
  // Legacy phases (kept for Zod validation of old v1 checkpoints)
  "original_deleted",
  "new_attr_created",
  "data_copied_back",
  "data_verified_final",
  "backup_deleted",
]);
export type CheckpointPhase = z.infer<typeof CheckpointPhase>;

export const CheckpointEntrySchema = z.object({
  databaseId: z.string(),
  collectionId: z.string(),
  attributeKey: z.string(),
  backupKey: z.string(),
  phase: CheckpointPhase,
  targetType: MigrationTargetType,
  targetSize: z.number().optional(),
  error: z.string().optional(),
  // Store index definitions for recreation after attribute delete
  storedIndexes: z
    .array(
      z.object({
        key: z.string(),
        type: z.string(),
        attributes: z.array(z.string()),
        orders: z.array(z.string()).optional(),
      })
    )
    .default([]),
});
export type CheckpointEntry = z.infer<typeof CheckpointEntrySchema>;

export const MigrationCheckpointSchema = z.object({
  version: z.number().default(1),
  planFile: z.string(),
  startedAt: z.string(),
  lastUpdatedAt: z.string(),
  entries: z.array(CheckpointEntrySchema),
});
export type MigrationCheckpoint = z.infer<typeof MigrationCheckpointSchema>;

// ── Options ──

export interface AnalyzeOptions {
  outputPath?: string;
  verbose?: boolean;
  databaseIds?: string[];
}

export interface ExecuteOptions {
  planPath: string;
  keepBackups?: boolean;
  dryRun?: boolean;
  batchSize?: number;
  batchDelayMs?: number;
  checkpointPath?: string;
  freshRun?: boolean;
  recentOnly?: number;
}

// ── Helper: suggest target type from size + index presence ──

export function suggestTargetType(
  size: number,
  hasIndex: boolean
): MigrationTargetType {
  // varchar supports up to 16,383 bytes and allows full indexing
  if (size <= 768) return "varchar";
  if (hasIndex) return "varchar"; // indexes require varchar
  if (size <= 16_383) return "text";
  if (size <= 4_000_000) return "mediumtext";
  return "longtext";
}

// ── Helper: generate backup key with length limits ──

const MAX_KEY_LENGTH = 36;
const BACKUP_PREFIX = "mig_";

export function generateBackupKey(originalKey: string): string {
  const candidate = `${BACKUP_PREFIX}${originalKey}`;
  if (candidate.length <= MAX_KEY_LENGTH) {
    return candidate;
  }
  // Truncate + 4-char hash for uniqueness: m_ + orig + _ + hash(4)
  const hash = simpleHash(originalKey);
  const TRUNC_PREFIX = "m_";
  const maxOrigLen = MAX_KEY_LENGTH - TRUNC_PREFIX.length - 1 - 4;
  return `${TRUNC_PREFIX}${originalKey.slice(0, maxOrigLen)}_${hash}`;
}

const ARCHIVE_PREFIX = "og_";

export function generateArchiveKey(originalKey: string): string {
  const candidate = `${ARCHIVE_PREFIX}${originalKey}`;
  if (candidate.length <= MAX_KEY_LENGTH) {
    return candidate;
  }
  const hash = simpleHash(originalKey);
  const TRUNC_PREFIX = "o_";
  const maxOrigLen = MAX_KEY_LENGTH - TRUNC_PREFIX.length - 1 - 4;
  return `${TRUNC_PREFIX}${originalKey.slice(0, maxOrigLen)}_${hash}`;
}

function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).slice(0, 4).padStart(4, "0");
}
