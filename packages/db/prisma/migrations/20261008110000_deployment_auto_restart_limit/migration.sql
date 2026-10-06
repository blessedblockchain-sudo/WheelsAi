-- Automatic restarts of a model deployment (a health_check task with
-- onDown = restart_deployment) are bounded per DEPLOYMENT, not per task, so
-- two tasks watching the same deployment share one limit. Each restart is a
-- new Nosana deployment with a fresh credit reservation; without a bound a
-- deployment that fails every time it starts was restarted on every tick.
--
-- auto_restart_count     automatic restarts tried in the current window
-- last_auto_restart_at   when the last one was tried; the next waits a
--                        growing backoff from here, and the window ends a
--                        day after it
--
-- Both are claimed by compare-and-set before the restart is asked for, and
-- cleared when the owner restarts the deployment by hand.
ALTER TABLE "deployments" ADD COLUMN "auto_restart_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "deployments" ADD COLUMN "last_auto_restart_at" TIMESTAMP(3);
