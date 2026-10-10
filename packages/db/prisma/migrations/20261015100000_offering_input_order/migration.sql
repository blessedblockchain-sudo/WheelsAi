-- The order of an offering's questions, and where its form came from.
--
--   offerings.input_order            the keys of the form's questions (the
--                                    top-level properties of input_schema)
--                                    in the order they were saved. The
--                                    schema checker refuses any ordering
--                                    keyword and JSONB does not keep the
--                                    order of an object's keys, so the order
--                                    rides beside the schema and is put back
--                                    on every read. Empty = no order was
--                                    recorded: the form is drawn as it is
--                                    today.
--   offerings.input_from_agent_form  true when the offering's form was taken
--                                    from its agent's own task form, false
--                                    when it was written by hand.
--
-- EXISTING ROWS. Every existing offering gets an empty order and false, both
-- written by a column default at ADD COLUMN, so no row is rewritten by a
-- statement of its own and none is missed. An existing offering's form is
-- drawn exactly as it was until its publisher saves it again.
--
-- No new table, no index and no constraint. input_schema is not touched, and
-- neither is any price, job, balance or status.
-- After a clean run these both count none:
--   SELECT count(*) FROM offerings WHERE cardinality(input_order) <> 0;
--   SELECT count(*) FROM offerings WHERE input_from_agent_form;

-- AlterTable
ALTER TABLE "offerings"
  ADD COLUMN "input_order" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "input_from_agent_form" BOOLEAN NOT NULL DEFAULT false;
