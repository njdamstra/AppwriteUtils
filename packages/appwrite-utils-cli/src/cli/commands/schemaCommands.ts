import inquirer from "inquirer";
import path from "path";
import chalk from "chalk";
import { MessageFormatter } from '@njdamstra/appwrite-utils-helpers';
import { SchemaGenerator } from '@njdamstra/appwrite-utils-helpers';
import { setupDirsFiles } from "../../utils/setupFiles.js";
import { fetchAllDatabases } from "../../databases/methods.js";
import type { InteractiveCLI } from "../../interactiveCLI.js";

export const schemaCommands = {
  async generateSchemas(cli: InteractiveCLI): Promise<void> {
    MessageFormatter.progress("Generating schemas...", { prefix: "Schemas" });

    // Prompt user for schema type preference
    const { schemaType } = await inquirer.prompt([
      {
        type: "list",
        name: "schemaType",
        message: "What type of schemas would you like to generate?",
        choices: [
          { name: "TypeScript (Zod) schemas", value: "zod" },
          { name: "JSON schemas", value: "json" },
          { name: "Python (Pydantic) models", value: "pydantic" },
          { name: "TypeScript + JSON", value: "both" },
          { name: "All (Zod, JSON, Pydantic)", value: "all" },
        ],
        default: "all",
      },
    ]);

    // Get the config folder path (where the config file is located)
    const configFolderPath = (cli as any).controller!.getAppwriteFolderPath();
    if (!configFolderPath) {
      MessageFormatter.error("Failed to get config folder path", undefined, { prefix: "Schemas" });
      return;
    }

    // Prompt for schema output directory (optional override)
    const defaultSchemaOut = path.join(configFolderPath, (cli as any).controller!.config?.schemaConfig?.outputDirectory || 'schemas');
    const { schemaOutDir } = await inquirer.prompt([
      {
        type: 'input',
        name: 'schemaOutDir',
        message: 'Output directory for schemas:',
        default: defaultSchemaOut,
        validate: (input: string) => input && input.trim().length > 0 ? true : 'Please provide an output directory',
      }
    ]);

    // Create SchemaGenerator with the correct base path and generate schemas
    const schemaGenerator = new SchemaGenerator((cli as any).controller!.config!, configFolderPath);
    const outDirRel = path.isAbsolute(schemaOutDir) ? schemaOutDir : path.relative(configFolderPath, schemaOutDir);
    await schemaGenerator.generateSchemas({ format: schemaType as any, verbose: true, outputDir: outDirRel });

    MessageFormatter.success("Schema generation completed", { prefix: "Schemas" });
  },

  async generateConstants(cli: InteractiveCLI): Promise<void> {
    MessageFormatter.progress("Generating cross-language constants...", { prefix: "Constants" });

    if (!(cli as any).controller?.config) {
      MessageFormatter.error("No configuration found", undefined, { prefix: "Constants" });
      return;
    }

    const controller = (cli as any).controller!;

    // Prompt for data source
    const hasRemoteAccess = !!(controller.database && controller.storage && controller.appwriteServer);
    const { source } = await inquirer.prompt([
      {
        type: "list",
        name: "source",
        message: "Source for constants data:",
        choices: [
          { name: "Local config files", value: "local" },
          {
            name: hasRemoteAccess
              ? "Remote Appwrite API (enables DB_TABLES)"
              : chalk.gray("Remote Appwrite API (no API key configured)"),
            value: "remote",
            disabled: !hasRemoteAccess ? "Requires API key" : false,
          },
        ],
        default: "local",
      },
    ]);

    // Prompt for languages
    const { languages } = await inquirer.prompt([
      {
        type: "checkbox",
        name: "languages",
        message: "Select languages for constants generation:",
        choices: [
          { name: "TypeScript", value: "typescript", checked: true },
          { name: "JavaScript", value: "javascript" },
          { name: "Python", value: "python" },
          { name: "PHP", value: "php" },
          { name: "Dart", value: "dart" },
          { name: "JSON", value: "json" },
          { name: "Environment Variables", value: "env" },
        ],
        validate: (input: string[]) => {
          if (input.length === 0) {
            return "Please select at least one language";
          }
          return true;
        },
      },
    ]);

    // Prompt for which constants to include
    const { includeWhat } = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'includeWhat',
        message: 'Select which constants to generate:',
        choices: [
          { name: 'Databases', value: 'databases', checked: true },
          { name: 'Collections/Tables', value: 'collections', checked: true },
          { name: 'Buckets', value: 'buckets', checked: true },
          { name: 'Functions', value: 'functions', checked: true },
          {
            name: source === 'remote'
              ? 'DB_TABLES (collections grouped by database)'
              : chalk.gray('DB_TABLES (requires Remote source)'),
            value: 'dbTables',
            checked: source === 'remote',
            disabled: source !== 'remote' ? 'Requires Remote source' : false,
          },
        ],
        validate: (input: string[]) => input.length > 0 ? true : 'Select at least one category',
      }
    ]);

    // Determine default output directory based on config location
    const configPath = controller.getAppwriteFolderPath();
    const defaultOutputDir = configPath
      ? path.join(configPath, "constants")
      : path.join(process.cwd(), "constants");

    // Prompt for output directory
    const { outputDir } = await inquirer.prompt([
      {
        type: "input",
        name: "outputDir",
        message: "Output directory for constants files:",
        default: defaultOutputDir,
        validate: (input: string) => {
          if (!input.trim()) {
            return "Output directory cannot be empty";
          }
          return true;
        },
      },
    ]);

    try {
      const { ConstantsGenerator } = await import("@njdamstra/appwrite-utils-helpers");
      type Constants = import("@njdamstra/appwrite-utils-helpers").Constants;
      const generator = new ConstantsGenerator(controller.config);

      const include = {
        databases: includeWhat.includes('databases'),
        collections: includeWhat.includes('collections'),
        buckets: includeWhat.includes('buckets'),
        functions: includeWhat.includes('functions'),
        dbTables: includeWhat.includes('dbTables'),
      };

      let constantsOverride: Constants | undefined;

      if (source === 'remote') {
        const { fetchAllCollections } = await import("../../collections/methods.js");
        const { listBuckets } = await import("../../storage/methods.js");
        const { listFunctions } = await import("../../functions/methods.js");

        MessageFormatter.progress("Fetching constants from Appwrite API...", { prefix: "Constants" });

        const databases: Record<string, string> = {};
        const collections: Record<string, string> = {};
        const dbTables: Record<string, Record<string, string>> = {};

        const allDbs = await fetchAllDatabases(controller.database!);
        for (const db of allDbs) {
          const dbKey = generator.toConstantName(db.name || db.$id);
          databases[dbKey] = db.$id;

          const dbColls = await fetchAllCollections(db.$id, controller.database!);
          if (dbColls.length === 0) continue;

          const tableEntry: Record<string, string> = { __db: db.$id };
          for (const coll of dbColls) {
            let collKey = generator.toConstantName(coll.name || coll.$id);
            if (collections[collKey] && collections[collKey] !== coll.$id) {
              const existingId = collections[collKey];
              let existingDbKey: string | undefined;
              for (const [dk, entry] of Object.entries(dbTables)) {
                const match = Object.entries(entry).find(([k, v]) => k !== '__db' && v === existingId);
                if (match) { existingDbKey = dk; break; }
              }
              if (existingDbKey) {
                const prefixedExisting = `${existingDbKey}_${collKey}`;
                collections[prefixedExisting] = existingId;
                delete collections[collKey];
                for (const entry of Object.values(dbTables)) {
                  if (entry[collKey] === existingId) {
                    entry[prefixedExisting] = existingId;
                    delete entry[collKey];
                    break;
                  }
                }
              }
              collKey = `${dbKey}_${collKey}`;
            }
            collections[collKey] = coll.$id;
            tableEntry[collKey] = coll.$id;
          }
          dbTables[dbKey] = tableEntry;
        }

        const buckets: Record<string, string> = {};
        const bucketList = await listBuckets(controller.storage!);
        for (const bucket of bucketList.buckets) {
          const key = generator.toConstantName(bucket.name || bucket.$id);
          buckets[key] = bucket.$id;
        }

        const functions: Record<string, string> = {};
        const funcList = await listFunctions(controller.appwriteServer!);
        for (const func of funcList.functions) {
          const key = generator.toConstantName(func.name || func.$id);
          functions[key] = func.$id;
        }

        constantsOverride = { databases, collections, buckets, functions, dbTables };
        MessageFormatter.success(
          `Fetched ${Object.keys(databases).length} databases, ${Object.keys(collections).length} collections, ${Object.keys(buckets).length} buckets, ${Object.keys(functions).length} functions`,
          { prefix: "Constants" }
        );
      }

      MessageFormatter.info(`Generating constants for: ${languages.join(", ")}`, { prefix: "Constants" });
      await generator.generateFiles(languages, outputDir, include, constantsOverride);

      MessageFormatter.success(`Constants generated in ${outputDir}`, { prefix: "Constants" });
    } catch (error) {
      MessageFormatter.error("Failed to generate constants", error instanceof Error ? error : new Error(String(error)), { prefix: "Constants" });
    }
  },

  async importData(cli: InteractiveCLI): Promise<void> {
    MessageFormatter.progress("Importing data...", { prefix: "Import" });

    const { doBackup } = await inquirer.prompt([
      {
        type: "confirm",
        name: "doBackup",
        message: "Do you want to perform a backup before importing?",
        default: true,
      },
    ]);

    const databases = await (cli as any).selectDatabases(
      await fetchAllDatabases((cli as any).controller!.database!),
      "Select databases to import data into:",
      true
    );

    const collections = await (cli as any).selectCollectionsAndTables(
      databases[0],
      (cli as any).controller!.database!,
      "Select collections/tables to import data into (leave empty for all):",
      true
    );

    const { shouldWriteFile } = await inquirer.prompt([
      {
        type: "confirm",
        name: "shouldWriteFile",
        message: "Do you want to write the imported data to a file?",
        default: false,
      },
    ]);

    const options = {
      databases,
      collections: collections.map((c: any) => c.name),
      doBackup,
      importData: true,
      shouldWriteFile,
    };

    try {
      await (cli as any).controller!.importData(options);
      MessageFormatter.success("Data import completed successfully", { prefix: "Import" });
    } catch (error) {
      MessageFormatter.error("Error importing data", error instanceof Error ? error : new Error(String(error)), { prefix: "Import" });
    }
  },

  async setupDirsFiles(cli: InteractiveCLI, withExampleData: boolean = false): Promise<void> {
    await setupDirsFiles(withExampleData, (cli as any).currentDir);
  }
};
