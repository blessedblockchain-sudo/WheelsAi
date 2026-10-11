import pinoImport from "pino";

const isDev = process.env.NODE_ENV !== "production";
const pino = pinoImport as unknown as ((options: Record<string, unknown>) => {
  child: (bindings: Record<string, unknown>) => any;
}) & { stdSerializers: { err: (value: unknown) => unknown } };

/**
 * How an Error is written, under either key the code logs one by. Without a
 * serializer an Error is written as `{}`: its message and stack are not
 * enumerable. `err` has one by default. About a hundred log calls pass theirs
 * under `error`, the payment workers' among them, and each of those lines
 * said that something had failed and nothing about what. A value that is not
 * an Error (a code, a provider's answer) is written as it is.
 */
export const logSerializers = {
  err: pino.stdSerializers.err,
  error: pino.stdSerializers.err,
};

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),
  serializers: logSerializers,
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
