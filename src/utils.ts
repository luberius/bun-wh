import { spawn } from "bun";
import type { Config } from "./types";
import loggerPino from "./logger";

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
  cwd: string,
): Promise<void> {
  const logger = loggerPino.child({ component: "command-executor" });

  for (const command of commands) {
    logger.debug({ command, cwd }, "Executing command");

    const [cmd, ...args] = command.split(" ");
    const proc = spawn([cmd, ...args], {
      cwd,
      stdio: ["inherit", "inherit", "inherit"],
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      logger.error({ command, exitCode }, "Command failed");
      throw new Error(`Command failed: ${command}`);
    }

    logger.debug({ command }, "Command completed successfully");
  }
}

export async function createSymlink(
  target: string,
  link: string,
): Promise<void> {
  const logger = loggerPino.child({ component: "symlink" });

  try {
    logger.debug({ target, link }, "Creating symlink");
    await Bun.write(link, ""); // Remove if exists
    await spawn(["ln", "-sfn", target, link]).exited;
    logger.debug({ target, link }, "Symlink created successfully");
  } catch (error) {
    logger.error({ error, target, link }, "Failed to create symlink");
    throw new Error(`Failed to create symlink: ${(error as any).message}`);
  }
}
