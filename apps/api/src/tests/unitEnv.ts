// Defaults for the environment variables config/env.ts requires, for unit
// tests that import app modules statically. Import this FIRST among a test
// file's app imports: ES module imports are evaluated in order, so the values
// are in place before config/env.ts loads. Nothing here is a secret.
process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "12345678901234567890123456789012";
