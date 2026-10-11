/**
 * Imported first by a command whose output an operator reads: the database
 * client then does not print its queries (packages/db/src/index.ts), so the
 * command's own lines are all there is. PRISMA_QUERY_LOG set to anything
 * else in the environment keeps them.
 */
process.env.PRISMA_QUERY_LOG ??= "off";
