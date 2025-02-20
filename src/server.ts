import type { Config, ReleaseInfo } from "./types";
import { ReleaseManager } from "./release-manager";
import { loadConfig } from "./utils";
import logger from "./logger";
import type pino from "pino";

let config: Config;

function verifySignature(signature: string | null, body: string): boolean {
  if (!signature) return false;
  const hmac = new Bun.CryptoHasher("sha256", config.webhookSecret);
  const calculatedSignature = "sha256=" + hmac.update(body).digest("hex");
  return signature === calculatedSignature;
}

async function handleRelease(
  req: Request,
  reqLogger: pino.Logger,
): Promise<Response> {
  try {
    const body = await req.text();
    const signature = req.headers.get("x-hub-signature-256");
    const event = req.headers.get("x-github-event");

    reqLogger.debug({ event }, "Received webhook");

    if (!verifySignature(signature, body)) {
      reqLogger.warn("Invalid webhook signature");
      return new Response("Invalid signature", { status: 401 });
    }

    if (event !== "release") {
      reqLogger.warn({ event }, "Unsupported event type");
      return new Response("This endpoint only handles release events", {
        status: 400,
      });
    }

    const release = JSON.parse(body);

    if (release.action !== "published") {
      reqLogger.info(
        { action: release.action },
        "Ignoring non-published release",
      );
      return new Response(`Ignoring ${release.action} action`, {
        status: 200,
      });
    }

    // Find matching project
    const project = Object.values(config.projects).find(
      (p) => p.githubRepo === release.repository.full_name,
    );

    if (!project) {
      reqLogger.warn(
        { repo: release.repository.full_name },
        "No matching project",
      );
      return new Response("No matching project configuration found", {
        status: 404,
      });
    }

    reqLogger.info({ project: project.name }, "Processing release");

    // Check branch if specified
    if (project.branch && release.release.target_commitish !== project.branch) {
      reqLogger.warn(
        {
          expectedBranch: project.branch,
          actualBranch: release.release.target_commitish,
        },
        "Branch mismatch",
      );
      return new Response(
        `Release branch ${release.release.target_commitish} doesn't match configured branch ${project.branch}`,
        { status: 400 },
      );
    }

    const releaseInfo: ReleaseInfo = {
      tagName: release.release.tag_name,
      zipUrl: release.release.zipball_url,
      isDraft: release.release.draft,
      isPrerelease: release.release.prerelease,
      repositoryName: release.repository.full_name,
      targetCommitish: release.release.target_commitish,
    };

    const releaseManager = new ReleaseManager(
      config.baseDir,
      project,
      config.githubToken,
    );
    const extractPath = await releaseManager.deploy(releaseInfo);

    reqLogger.info(
      {
        project: project.name,
        tag: releaseInfo.tagName,
        path: extractPath,
      },
      "Release processed successfully",
    );

    return Response.json({
      message: "Release processed successfully",
      project: project.name,
      extractPath,
      releaseInfo,
    });
  } catch (error) {
    reqLogger.error({ error }, "Error processing webhook");
    return Response.json(
      {
        error: "Failed to process release",
        details: (error as any).message,
      },
      { status: 500 },
    );
  }
}

export default async function runServer() {
  logger.info("Starting server initialization");

  try {
    config = await loadConfig();
    logger.info(
      {
        projects: Object.keys(config.projects),
      },
      "Configuration loaded",
    );

    const server = Bun.serve({
      port: process.env.PORT || 3000,
      fetch(req) {
        const reqLogger = logger.child({
          reqId: crypto.randomUUID(),
          method: req.method,
          url: req.url,
        });

        const url = new URL(req.url);
        const path = url.pathname;

        // Health check endpoint
        if (req.method === "GET" && path === "/health") {
          reqLogger.debug("Health check request");
          return new Response("OK");
        }

        // GitHub webhook endpoint
        if (req.method === "POST" && path === "/webhook/github/release") {
          return handleRelease(req, reqLogger);
        }

        // Not found
        reqLogger.warn({ path }, "Route not found");
        return new Response("Not Found", { status: 404 });
      },
    });

    logger.info({ port: server.port }, "Server started successfully");
  } catch (error) {
    logger.fatal({ error }, "Failed to initialize server");
    process.exit(1);
  }
}

// Initialize server
