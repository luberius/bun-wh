import pino from "pino";
import { mkdir } from "node:fs/promises";

// Ensure logs directory exists
await mkdir("logs", { recursive: true });

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: {
    targets: [
      {
        target: "pino/file",
        options: { destination: "./logs/server.log" },
        level: "info",
      },
      {
        target: "pino-pretty",
        options: { colorize: true },
        level: "info",
      },
    ],
  },
});

export default logger;
