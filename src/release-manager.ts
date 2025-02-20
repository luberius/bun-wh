import { join } from "path";
import type { ProjectConfig } from "./types";
import type { ReleaseInfo } from "./types";
import { executeCommands } from "./utils";
import logger from "./logger";
import type pino from "pino";
import { mkdir, readdir, realpath, rm, symlink } from "node:fs/promises";

// Improved createSymlink function that handles existing directories
async function createSymlink(target: string, link: string): Promise<void> {
  try {
    // Remove existing symlink or directory
    try {
      await rm(link, { recursive: true, force: true });
    } catch (error) {
      // Ignore errors if the link doesn't exist
    }

    // Create the new symlink
    await symlink(target, link);
  } catch (error) {
    throw new Error(`Failed to create symlink: ${(error as any).message}`);
  }
}

export class ReleaseManager {
  private config: ProjectConfig;
  private githubToken?: string;
  private logger: pino.Logger;
  private baseDir: string;
  private projectDir: string;

  constructor(baseDir: string, config: ProjectConfig, githubToken?: string) {
    this.baseDir = baseDir;
    this.config = config;
    this.githubToken = githubToken;
    this.projectDir = join(baseDir, "releases", config.name);
    this.logger = logger.child({
      project: config.name,
      component: "ReleaseManager",
    });
  }

  async deploy(releaseInfo: ReleaseInfo): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const releaseDir = join(
      this.projectDir,
      `${releaseInfo.tagName}-${timestamp}`,
    );
    const currentLink = join(this.baseDir, "current", this.config.name);
    const rollbackLink = join(this.baseDir, "rollback", this.config.name);

    this.logger.info({ releaseInfo, releaseDir }, "Starting deployment");

    try {
      // Ensure directories exist
      await mkdir(join(this.baseDir, "releases"), { recursive: true });
      await mkdir(this.projectDir, { recursive: true });
      await mkdir(join(this.baseDir, "current"), { recursive: true });
      await mkdir(join(this.baseDir, "rollback"), { recursive: true });
      await mkdir(releaseDir, { recursive: true });

      // Download and extract release
      await this.downloadAndExtract(releaseInfo.zipUrl, releaseDir);
      this.logger.info("Release downloaded and extracted");

      // Backup current deployment
      try {
        if (await Bun.file(currentLink).exists()) {
          const currentPath = await realpath(currentLink);
          await createSymlink(currentPath, rollbackLink);
          this.logger.info({ currentPath, rollbackLink }, "Created backup");
        }
      } catch (error) {
        this.logger.warn(
          { error },
          "Failed to create backup, continuing deployment",
        );
      }

      // Create/Update symlink with improved error handling
      await createSymlink(releaseDir, currentLink);
      this.logger.info(`Updated current symlink to: ${releaseDir}`);

      // Execute post-extract commands with template variables
      if (this.config.postExtract) {
        this.logger.info("Executing post-extract commands");
        const commands = this.config.postExtract.map((cmd) =>
          cmd
            .replace(/\{\{release\}\}/g, releaseDir)
            .replace(/\{\{webRoot\}\}/g, this.config.webRoot),
        );
        await executeCommands(commands, releaseDir);
      }

      // Cleanup old releases
      // await this.cleanup();

      return releaseDir;
    } catch (error) {
      this.logger.error({ error }, "Deployment failed, initiating rollback");
      await this.rollback();
      throw error;
    }
  }

  private async downloadAndExtract(
    zipUrl: string,
    targetDir: string,
  ): Promise<void> {
    this.logger.debug({ zipUrl, targetDir }, "Downloading release");

    const response = await fetch(zipUrl, {
      headers: this.githubToken
        ? {
            Authorization: `token ${this.githubToken}`,
          }
        : {},
    });

    if (!response.ok) {
      throw new Error(`Failed to download release: ${response.statusText}`);
    }

    const zipBuffer = await response.arrayBuffer();

    try {
      // Create a temporary file for the zip
      const zipPath = join(targetDir, "release.zip");
      await Bun.write(zipPath, zipBuffer);

      // Use Node's built-in child_process to unzip
      await new Promise((resolve, reject) => {
        const unzip = Bun.spawn(
          ["unzip", "-qq", "-o", zipPath, "-d", targetDir],
          {
            onExit: (_, exitCode, __, ___) => {
              if (exitCode === 0) resolve(undefined);
              else reject(new Error(`unzip failed with code ${exitCode}`));
            },
          },
        );
      });

      // Clean up zip file
      await Bun.file(zipPath).delete();

      this.logger.debug("Release extracted successfully");
    } catch (error) {
      this.logger.error({ error }, "Failed to extract release");
      throw error;
    }
  }

  async rollback(): Promise<void> {
    const rollbackLink = join(this.baseDir, "rollback", this.config.name);
    const currentLink = join(this.baseDir, "current", this.config.name);

    this.logger.info("Starting rollback procedure");

    if (await Bun.file(rollbackLink).exists()) {
      if (this.config.preRollback) {
        this.logger.info("Executing pre-rollback commands");
        const commands = this.config.preRollback.map((cmd) =>
          cmd.replace(/\{\{webRoot\}\}/g, this.config.webRoot),
        );
        await executeCommands(commands, this.config.webRoot);
      }

      const rollbackPath = await realpath(rollbackLink);
      await createSymlink(rollbackPath, currentLink);

      // Update web root symlink if configured
      if (this.config.webRoot) {
        const commands = [
          `ln -sfn ${rollbackPath}/public ${this.config.webRoot}`,
        ];
        await executeCommands(commands, rollbackPath);
      }

      this.logger.info({ rollbackPath }, "Rollback completed");
    } else {
      this.logger.warn("No backup found for rollback");
    }
  }

  private async cleanup(): Promise<void> {
    const releases = await readdir(this.projectDir);

    this.logger.info(
      {
        totalReleases: releases.length,
        keepReleases: this.config.keepReleases,
      },
      "Starting cleanup",
    );

    if (releases.length > this.config.keepReleases) {
      const toRemove = releases
        .sort()
        .slice(0, releases.length - this.config.keepReleases);

      for (const release of toRemove) {
        const releasePath = join(this.projectDir, release);
        await rm(releasePath, { recursive: true, force: true });
        this.logger.info({ releasePath }, "Removed old release");
      }
    }
  }
}
