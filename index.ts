import logger from "./src/logger";
import runServer from "./src/server";

runServer().catch((error) => {
  logger.fatal({ error }, "Unhandled error during server initialization");
  process.exit(1);
});

process.on("SIGINT", () => {
  logger.info("Received SIGINT signal");
  logger.info("Shutting down server...");
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  logger.fatal({ error }, "Uncaught exception");
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  logger.fatal({ error }, "Unhandled rejection");
  process.exit(1);
});
