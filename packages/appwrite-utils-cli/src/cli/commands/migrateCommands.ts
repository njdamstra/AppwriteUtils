import inquirer from "inquirer";
import path from "node:path";
import fs from "node:fs";
import { MessageFormatter } from "@njdamstra/appwrite-utils-helpers";
import type { InteractiveCLI } from "../../interactiveCLI.js";
import {
  analyzeStringAttributes,
  executeMigrationPlan,
} from "../../migrations/migrateStrings.js";
import type { AnalyzeOptions, ExecuteOptions } from "../../migrations/migrateStringsTypes.js";

export const migrateCommands = {
  async migrateStrings(cli: InteractiveCLI): Promise<void> {
    const { phase } = await inquirer.prompt([
      {
        type: "list",
        name: "phase",
        message: "String attribute migration:",
        choices: [
          {
            name: "Analyze — scan Appwrite server, generate migration plan (YAML)",
            value: "analyze",
          },
          {
            name: "Execute — run a migration plan against Appwrite server",
            value: "execute",
          },
          { name: "Back", value: "back" },
        ],
      },
    ]);

    if (phase === "back") return;
    if (phase === "analyze") {
      await migrateCommands.analyzePhase(cli);
    } else {
      await migrateCommands.executePhase(cli);
    }
  },

  async analyzePhase(cli: InteractiveCLI): Promise<void> {
    const controller = (cli as any).controller;
    if (!controller?.adapter) {
      MessageFormatter.error(
        "No database adapter available. Ensure a server connection is established.",
        undefined,
        { prefix: "Analyze" }
      );
      return;
    }

    // Prompt for database selection
    const allDatabases = controller.config.databases || [];
    let databaseIds: string[] | undefined;
    if (allDatabases.length > 1) {
      const { selectedDbs } = await inquirer.prompt([
        {
          type: "checkbox",
          name: "selectedDbs",
          message: "Select databases to include in the analysis:",
          choices: allDatabases.map((db: any) => ({
            name: `${db.name} (${db.$id})`,
            value: db.$id,
            checked: true,
          })),
        },
      ]);
      if (selectedDbs.length === 0) {
        MessageFormatter.warning("No databases selected. Aborting.", { prefix: "Analyze" });
        return;
      }
      if (selectedDbs.length < allDatabases.length) {
        databaseIds = selectedDbs;
      }
    }

    // Prompt for output path
    const { outputPath } = await inquirer.prompt([
      {
        type: "input",
        name: "outputPath",
        message: "Output path for migration plan:",
        default: path.join(process.cwd(), "migrate-strings-plan.yaml"),
      },
    ]);

    const options: AnalyzeOptions = { outputPath, databaseIds };

    try {
      await analyzeStringAttributes(controller.adapter, controller.config, options);
      MessageFormatter.success(
        "Analysis complete. Review the YAML plan, edit targetType/action as needed, then run Execute.",
        { prefix: "Analyze" }
      );
    } catch (err: any) {
      MessageFormatter.error(
        `Analysis failed: ${err.message}`,
        undefined,
        { prefix: "Analyze" }
      );
    }
  },

  async executePhase(cli: InteractiveCLI): Promise<void> {
    const controller = (cli as any).controller;
    if (!controller?.adapter) {
      MessageFormatter.error(
        "No database adapter available. Ensure a server connection is established.",
        undefined,
        { prefix: "Execute" }
      );
      return;
    }

    // Prompt for plan path
    const { planPath } = await inquirer.prompt([
      {
        type: "input",
        name: "planPath",
        message: "Path to migration plan YAML:",
        default: path.join(process.cwd(), "migrate-strings-plan.yaml"),
      },
    ]);

    // Check for existing checkpoint
    let freshRun = false;
    const checkpointPath = planPath.replace(/\.ya?ml$/, ".checkpoint.json");
    if (fs.existsSync(checkpointPath)) {
      const { cpAction } = await inquirer.prompt([
        {
          type: "list",
          name: "cpAction",
          message: "Found an existing checkpoint from a previous run. What would you like to do?",
          choices: [
            { name: "Resume — continue from where it left off", value: "resume" },
            { name: "Start fresh — delete checkpoint and start over", value: "fresh" },
            { name: "Cancel", value: "cancel" },
          ],
        },
      ]);
      if (cpAction === "cancel") return;
      if (cpAction === "fresh") freshRun = true;
    }

    const { keepBackups } = await inquirer.prompt([
      {
        type: "confirm",
        name: "keepBackups",
        message: "Keep backup attributes after migration? (safer, uses more attribute slots)",
        default: true,
      },
    ]);

    const { dryRun } = await inquirer.prompt([
      {
        type: "confirm",
        name: "dryRun",
        message: "Dry run? (no actual changes)",
        default: false,
      },
    ]);

    const { recentOnlyInput } = await inquirer.prompt([
      {
        type: "input",
        name: "recentOnlyInput",
        message: "Migrate only N most recent rows per attribute? (leave blank for all):",
        default: "",
      },
    ]);
    const recentOnly = recentOnlyInput ? parseInt(recentOnlyInput, 10) : undefined;

    const options: ExecuteOptions = {
      planPath,
      keepBackups,
      dryRun,
      freshRun,
      recentOnly,
    };

    try {
      const results = await executeMigrationPlan(controller.adapter, options);
      if (results.failed > 0) {
        MessageFormatter.warning(
          `Migration completed with ${results.failed} failure(s). Check checkpoint file to resume.`,
          { prefix: "Execute" }
        );
      } else {
        MessageFormatter.success("Migration completed successfully.", {
          prefix: "Execute",
        });
      }
    } catch (err: any) {
      MessageFormatter.error(
        `Execution failed: ${err.message}`,
        undefined,
        { prefix: "Execute" }
      );
    }
  },
};
