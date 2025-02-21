import { $, spawn } from "bun";
import type { Config, CopyOptions } from "./types";
import loggerPino from "./logger";
import { rm, readdir, mkdir, copyFile, stat } from "node:fs/promises";
import { join } from "node:path";

export async function loadConfig(): Promise<Config> {
  const configPath = process.env.CONFIG_PATH || "./config.json";
  try {
    const configFile = Bun.file(configPath);
    return JSON.parse(await configFile.text());
  } catch (error) {
    loggerPino.error({ error, configPath }, "Failed to load config");
    throw new Error(`Failed to load config from ${configPath}`);
  }
}

export async function executeCommands(
  commands: string[],
  cwd?: string,
): Promise<void> {
  for (const command of commands) {
    let errMsg, code;

    if (!cwd) {
      const { stderr, exitCode } = await $`${command}`.nothrow().quiet();
      errMsg = stderr;
      code = exitCode;
    } else {
      const { stderr, exitCode } = await $`${command}`
        .cwd(cwd)
        .nothrow()
        .quiet();

      errMsg = stderr;
      code = exitCode;
    }

    if (code !== 0) {
      throw new Error(
        `Command failed with exit code ${code}: ${command}\nstderr: ${errMsg}`,
      );
    }
  }
}

export async function createSymlink(
  target: string,
  link: string,
): Promise<void> {
  const logger = loggerPino.child({ component: "symlink" });

  try {
    logger.debug({ target, link }, "Creating symlink");
    await rm(link, { recursive: true, force: true });
    await spawn(["ln", "-sfn", target, link]).exited;
    logger.debug({ target, link }, "Symlink created successfully");
  } catch (error) {
    logger.error({ error, target, link }, "Failed to create symlink");
    throw new Error(`Failed to create symlink: ${(error as any).message}`);
  }
}

export async function copyDirectoryRecursive(
  sourcePath: string,
  destinationPath: string,
  options: CopyOptions = {},
) {
  try {
    // Clear destination if requested
    if (options.clearDestination) {
      console.log("Clearing destination directory...");
      await rm(destinationPath, { recursive: true, force: true });
      console.log("Destination directory cleared.");
    }

    // Read all files and directories in the source path
    const entries = await readdir(sourcePath, { withFileTypes: true });

    // Create destination directory if it doesn't exist
    await mkdir(destinationPath, { recursive: true }).catch(() => {});

    // Create an array to store copy operations
    const copyOperations = entries.map(async (entry) => {
      const sourceEntryPath = join(sourcePath, entry.name);
      const destEntryPath = join(destinationPath, entry.name);

      try {
        if (entry.isDirectory()) {
          // Recursively copy subdirectories
          await copyDirectoryRecursive(sourceEntryPath, destEntryPath, options);
          console.log(`Copied directory: ${entry.name}`);
        } else {
          // Check if file exists and handle according to replace option
          const fileExists = await stat(destEntryPath).catch(() => false);

          if (!fileExists || options.replace) {
            await copyFile(sourceEntryPath, destEntryPath);
            console.log(`Copied file: ${entry.name}`);
          } else {
            console.log(`Skipped existing file: ${entry.name}`);
          }
        }
      } catch (err) {
        console.error(`Error copying ${entry.name}:`, err);
      }
    });

    // Wait for all copy operations to complete
    await Promise.all(copyOperations);
  } catch (err) {
    console.error("Error reading directory:", err);
  }
}
