import { PrismaClient } from "@prisma/client";

// Prevent multiple instances of Prisma Client in development
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// In development every query is printed, unless PRISMA_QUERY_LOG=off: a
// command an operator runs prints its answer, not the SQL behind it.
const development = process.env.NODE_ENV === "development";
const printQueries = development && process.env.PRISMA_QUERY_LOG !== "off";

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: printQueries
      ? ["query", "error", "warn"]
      : development
        ? ["error", "warn"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export * from "@prisma/client";
export { Prisma } from "@prisma/client";
