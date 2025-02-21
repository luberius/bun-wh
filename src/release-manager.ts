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

  private async getAssetDownloadUrl(releaseInfo: ReleaseInfo): Promise<string> {
    const apiUrl = `https://api.github.com/repos/${releaseInfo.repoOwner}/${releaseInfo.repoName}/releases/tags/${releaseInfo.tagName}`;

    const response = await fetch(apiUrl, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        ...(this.githubToken && {
          Authorization: `token ${this.githubToken}`,
        }),
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch release info: ${response.statusText}`);
    }

    const releaseData: any = await response.json();
    const asset = releaseData.assets.find(
      (asset: any) => asset.name === this.config.asset,
    );

    if (!asset) {
      throw new Error(
        `Asset ${this.config.asset} not found in release ${releaseInfo.tagName}`,
      );
    }

    return asset.url;
  }

  async deploy(releaseInfo: ReleaseInfo) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const releaseDir = join(
      this.projectDir,
      `${releaseInfo.tagName}-${timestamp}`,
    );

    this.logger.info({ releaseInfo, releaseDir }, "Starting deployment");

    try {
      // Ensure directories exist
      await mkdir(join(this.baseDir, "releases"), { recursive: true });
      await mkdir(this.projectDir, { recursive: true });
      await mkdir(join(this.baseDir, "current"), { recursive: true });
      await mkdir(join(this.baseDir, "rollback"), { recursive: true });
      await mkdir(releaseDir, { recursive: true });

      // Get the asset download URL from GitHub API
      const downloadUrl = await this.getAssetDownloadUrl(releaseInfo);
      this.logger.info({ downloadUrl }, "Found asset download URL");

      // Download and extract release
      await this.downloadAndExtract(downloadUrl, releaseDir);
      this.logger.info("Release downloaded and extracted");

      // ... rest of deploy code ...
    } catch (error) {
      this.logger.error({ error }, "Deployment failed, initiating rollback");
      await this.rollback();
      throw error;
    }
  }

  private async downloadAndExtract(
    downloadUrl: string,
    targetDir: string,
  ): Promise<void> {
    this.logger.debug({ downloadUrl, targetDir }, "Downloading release");

    const zipPath = join(targetDir, "release.zip");

    try {
      // Step 1: Download with curl
      const curlArgs = [
        "curl",
        "-L", // Follow redirects
        "-s", // Silent
        "-H",
        "'Accept: application/octet-stream'",
        "-o",
        zipPath,
      ];
      if (this.githubToken) {
        curlArgs.push("-H", `'Authorization: Bearer ${this.githubToken}'`);
      }

      curlArgs.push(downloadUrl);

      // Execute download
      await new Promise((resolve, reject) => {
        Bun.spawn(curlArgs, {
          onExit: (_, exitCode, __, ___) => {
            if (exitCode === 0) {
              resolve(undefined);
            } else {
              reject(new Error(`curl failed with code ${exitCode}`));
            }
          },
        });
      });

      // Step 2: Process with sed to strip before ZIP header and after boundary end
      await new Promise((resolve, reject) => {
        Bun.spawn(["sed", "-i", "-n", `/PK\\x03\\x04/,/^--/p`, zipPath], {
          onExit: (_, exitCode, __, ___) => {
            if (exitCode === 0) resolve(undefined);
            else reject(new Error(`sed failed with code ${exitCode}`));
          },
        });
      });

      // Step 3: Extract
      await new Promise((resolve, reject) => {
        Bun.spawn(["unzip", "-qq", "-o", zipPath, "-d", targetDir], {
          onExit: (_, exitCode, __, ___) => {
            if (exitCode === 0) resolve(undefined);
            else reject(new Error(`unzip failed with code ${exitCode}`));
          },
        });
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
