import { join } from "path";
import type { ProjectConfig } from "./types";
import type { ReleaseInfo } from "./types";
import {
  copyDirectoryRecursive,
  createSymlink,
  executeCommands,
} from "./utils";
import logger from "./logger";
import type pino from "pino";
import { mkdir, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

// Improved createSymlink function that handles existing directories
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

    // Validate webRoot if provided
    if (config.webRoot && !path.isAbsolute(config.webRoot)) {
      throw new Error("webRoot must be an absolute path");
    }
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

  private async downloadAndExtract(
    downloadUrl: string,
    targetDir: string,
  ): Promise<void> {
    this.logger.info({ downloadUrl, targetDir }, "Downloading release");

    const zipPath = join(targetDir, "release.zip");

    try {
      // Step 1: Download with curl
      const curlArgs = [
        "curl",
        "-L", // Follow redirects
        "-s", // Silent
        "-o",
        zipPath,
      ];

      if (this.githubToken) {
        curlArgs.push("-H", `Authorization: token ${this.githubToken}`);
      }

      curlArgs.push("-H", `Accept: application/octet-stream`);
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

      // Step 2: Clean the binary file
      const fileContent = await Bun.file(zipPath).arrayBuffer();
      const bytes = new Uint8Array(fileContent);

      // Find ZIP header (PK\x03\x04)
      let startIndex = -1;
      for (let i = 0; i < bytes.length - 4; i++) {
        if (
          bytes[i] === 0x50 && // P
          bytes[i + 1] === 0x4b && // K
          bytes[i + 2] === 0x03 && // \x03
          bytes[i + 3] === 0x04 // \x04
        ) {
          startIndex = i;
          break;
        }
      }

      // Find boundary at the end (--boundary--)
      let endIndex = bytes.length;
      for (let i = bytes.length - 1; i >= 0; i--) {
        if (bytes[i] === 0x2d && bytes[i - 1] === 0x2d) {
          // '--'
          endIndex = i - 1;
          break;
        }
      }

      if (startIndex === -1) {
        throw new Error("ZIP header not found in file");
      }

      // Write cleaned ZIP file
      const cleanedContent = bytes.slice(startIndex, endIndex);
      await Bun.write(zipPath, cleanedContent);

      // Log file size after cleaning
      const sizeAfterCleaning = cleanedContent.length;
      this.logger.debug(`File size after cleaning: ${sizeAfterCleaning} bytes`);
      if (sizeAfterCleaning === 0) {
        throw new Error("File is empty after cleaning");
      }

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

  private async updateWebRoot(releasePath: string): Promise<void> {
    if (!this.config.webRoot) return;

    try {
      // Ensure webRoot exists
      await mkdir(this.config.webRoot, { recursive: true });

      // Remove existing contents
      const existing = await readdir(this.config.webRoot);
      for (const item of existing) {
        const fullPath = join(this.config.webRoot, item);
        await rm(fullPath, { recursive: true, force: true });
      }

      copyDirectoryRecursive(releasePath, this.config.webRoot, {
        clearDestination: true,
      });

      this.logger.info(
        { webRoot: this.config.webRoot },
        "Updated web root contents",
      );
    } catch (error) {
      throw new Error(`Failed to update web root: ${(error as any).message}`);
    }
  }

  async deploy(releaseInfo: ReleaseInfo) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const releaseDir = join(
      this.projectDir,
      `${releaseInfo.tagName}-${timestamp}`,
    );
    const currentLink = join(this.baseDir, "current", this.config.name);
    let previousReleasePath: string | undefined;

    this.logger.info({ releaseInfo, releaseDir }, "Starting deployment");

    try {
      // Ensure directories exist
      await mkdir(join(this.baseDir, "releases"), { recursive: true });
      await mkdir(this.projectDir, { recursive: true });
      await mkdir(join(this.baseDir, "current"), { recursive: true });
      await mkdir(releaseDir, { recursive: true });

      // Get the asset download URL from GitHub API
      const downloadUrl = await this.getAssetDownloadUrl(releaseInfo);
      this.logger.info({ downloadUrl }, "Found asset download URL");

      // Download and extract release
      await this.downloadAndExtract(downloadUrl, releaseDir);
      this.logger.info("Release downloaded and extracted");

      // Store previous release path before updating symlink
      try {
        previousReleasePath = await realpath(currentLink);
      } catch (error) {
        // No previous release exists
      }

      // Update current symlink
      await createSymlink(releaseDir, currentLink);

      // Copy contents to webRoot
      await this.updateWebRoot(releaseDir);

      // Cleanup old releases
      await this.cleanup();
    } catch (error) {
      this.logger.error({ error }, "Deployment failed, initiating rollback");
      if (previousReleasePath) {
        await this.rollback(previousReleasePath);
      }
      throw error;
    }
  }

  async rollback(previousReleasePath: string): Promise<void> {
    const currentLink = join(this.baseDir, "current", this.config.name);

    this.logger.info("Starting rollback procedure");

    if (previousReleasePath) {
      if (this.config.preRollback) {
        this.logger.info("Executing pre-rollback commands");
        const commands = this.config.preRollback.map((cmd) =>
          cmd.replace(/\{\{webRoot\}\}/g, this.config.webRoot),
        );
        await executeCommands(commands, this.config.webRoot);
      }

      // Update current symlink to previous release
      await createSymlink(previousReleasePath, currentLink);

      // Copy previous release contents to webRoot
      await this.updateWebRoot(previousReleasePath);

      this.logger.info({ previousReleasePath }, "Rollback completed");
    } else {
      this.logger.warn("No previous release found for rollback");
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
