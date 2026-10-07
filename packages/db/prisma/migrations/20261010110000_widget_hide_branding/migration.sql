-- "Powered by WheelsAI" on the web chat widget is the owner's choice only on
-- a plan with white-labelling. The column stores the choice; whether it takes
-- effect is decided from the plan each time the widget loads, so a downgrade
-- brings the line back without touching this row.

-- AlterTable
ALTER TABLE "widget_keys" ADD COLUMN     "hide_branding" BOOLEAN NOT NULL DEFAULT false;
