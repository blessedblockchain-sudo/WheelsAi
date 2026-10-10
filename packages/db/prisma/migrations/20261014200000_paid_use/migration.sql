-- Paid use of the creator's agent: a listing says what it sells, and a
-- buyer's licence says what it is for.
--
--   agent_listings.sells                  'use' (the buyer uses the creator's
--                                         own agent, on its page or through
--                                         the API, and never sees its
--                                         instructions) or 'copies' (the buyer
--                                         gets a copy, instructions included).
--   agent_listings.use_allowed_tools      outbound tools the creator allows
--                                         for people who pay to use the agent,
--                                         by name. Empty = none.
--   agent_listings.use_model_cost_micros  a running total, in millionths of a
--                                         cent, of what delivered paid uses
--                                         cost on the platform's model keys.
--                                         Each settle adds to it, and only the
--                                         whole cents the total has just
--                                         crossed leave the creator's amount.
--   agent_installs.kind                   'copy' (the row is the licence for a
--                                         copy; cloned_agent_id names it) or
--                                         'use' (the licence to use the
--                                         creator's agent; cloned_agent_id
--                                         stays NULL).
--   api_keys.max_use_price_cents          the most one paid use may cost for a
--                                         key granted agents:use. NULL on
--                                         every other key.
--
-- EXISTING ROWS. Every existing listing sells copies, which is what it has
-- always sold, and every existing install is a copy. Both are written by a
-- column default at ADD COLUMN, so no row is rewritten by a statement of
-- its own and none is missed. Every existing API key gets NULL and cannot
-- pay for use.
--
-- agent_listings.sells is then left WITHOUT a default: code that creates a
-- listing must say what it sells, and an INSERT that does not is refused by
-- the database. agent_installs.kind keeps its default, 'copy'.
--
-- No new table. Nothing is charged, paused or re-priced here: no price, no
-- accepted price, no subscription, no balance and no status is touched.
-- After a clean run these both count none:
--   SELECT count(*) FROM agent_listings WHERE sells <> 'copies';
--   SELECT count(*) FROM agent_installs WHERE kind <> 'copy';

-- AlterTable
ALTER TABLE "agent_listings"
  ADD COLUMN "sells" TEXT NOT NULL DEFAULT 'copies',
  ADD COLUMN "use_allowed_tools" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "use_model_cost_micros" BIGINT NOT NULL DEFAULT 0;

-- Every existing listing is 'copies' now. From here on a listing says what
-- it sells.
ALTER TABLE "agent_listings" ALTER COLUMN "sells" DROP DEFAULT;

ALTER TABLE "agent_listings" ADD CONSTRAINT "agent_listings_sells_check" CHECK ("sells" IN ('use', 'copies'));

-- AlterTable
ALTER TABLE "agent_installs" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'copy';

ALTER TABLE "agent_installs" ADD CONSTRAINT "agent_installs_kind_check" CHECK ("kind" IN ('copy', 'use'));

-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN "max_use_price_cents" BIGINT;
