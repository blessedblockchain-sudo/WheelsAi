import pinoImport from "pino";

const isDev = process.env.NODE_ENV !== "production";
const pino = pinoImport as unknown as (options: Record<string, unknown>) => {
  child: (bindings: Record<string, unknown>) => any;
};

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),
  transport: isDev
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss",
          ignore: "pid,hostname",
        },
      }
    : undefined,
  base: {
    service: "wheelsai-api",
    env: process.env.NODE_ENV ?? "development",
  },
});

export function createLogger(context: string) {
  return logger.child({ context });
}
