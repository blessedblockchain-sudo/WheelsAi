/**
 * Imported first by a command whose output an operator reads: the database
 * client then does not print its queries (packages/db/src/index.ts), so the
 * command's own lines are all there is. To see them, set PRISMA_QUERY_LOG to
 * anything else in the shell the command is run from: this runs before the
 * settings file is read, so a line in that file does not change it.
 */
process.env.PRISMA_QUERY_LOG ??= "off";
