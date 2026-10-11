-- A listing that sells use of its agent is paused while the model the agent
-- runs on, one its organization runs itself, is not answering: nobody can
-- start using it, nobody is charged, and no subscription to it is renewed.
--
--   agent_listings gains paused_since: when the subscribers' clock stopped.
--                  It is set when the pause is seen and cleared when it is
--                  over, and each month paid for is then made longer by the
--                  time in between (services/listingPause.ts).
--
-- EXISTING ROWS. Nothing is rewritten: no listing is paused until the worker
-- or a stopped deployment says so.

-- AlterTable
ALTER TABLE "agent_listings" ADD COLUMN "paused_since" TIMESTAMP(3);
