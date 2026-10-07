-- Custom domains with real TLS.
--
-- Until now a domain's certificate was marked "active" by a timer two seconds
-- after its TXT record was found: no certificate existed, no request was ever
-- routed, and the 90-day expiry was invented. From here on every status on
-- this table is something the checker observed (DNS answers, the certificate
-- the edge proxy presents), and this migration takes back what was made up.
--
-- Ownership claims
--   domain            no longer globally unique. Any organisation may hold a
--                     PENDING claim on a name; an unverified claim must not be
--                     able to block the real owner.
--   verified_domain   equals domain only while the claim is verified, and is
--                     unique: the first organisation to prove ownership holds
--                     the name. Cleared on expiry, re-verification and delete.
--                     The edge and the router look hostnames up by this column.
--   verification_started_at  start of the 14 days a pending claim has to verify
--   verification_lost_at     when a verified domain's TXT record was first seen
--                            missing; it keeps serving for 72 hours from here
--
-- Serving
--   enabled           what the owner asked for (the on/off switch)
--   is_active         now DERIVED and written only by the check core: enabled
--                     and verified and routed and certificate active and plan
--                     entitled and target present
--   paused_reason     why a domain is not serving: disabled | plan_inactive |
--                     target_missing | verification_lost | dns_not_routed |
--                     certificate_invalid
--
-- Routing observation (do the domain's addresses all belong to the edge?)
--   routing_status    pending | ok | misrouted | unresolvable
--   routing_failures  consecutive not-ok observations of a routed domain; one
--                     bad DNS answer must not take a live domain down
--   observed_addresses, routing_checked_at, routing_error, is_apex
--
-- Certificate observation (read from a TLS handshake with the edge)
--   ssl_checked_at, ssl_valid_from, ssl_issuer, ssl_fingerprint256
--   ssl_failures            consecutive failed handshakes
--   ssl_provisioning_since  when the domain first qualified for a certificate
--
-- Scheduling
--   next_check_at     when the checker looks at the row again; NULL = never
--                     (expired claims)

DROP INDEX "custom_domains_domain_key";

ALTER TABLE "custom_domains"
  ADD COLUMN "verified_domain" TEXT,
  ADD COLUMN "verification_started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "verification_lost_at" TIMESTAMP(3),
  ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "paused_reason" TEXT,
  ADD COLUMN "routing_status" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "routing_failures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "routing_checked_at" TIMESTAMP(3),
  ADD COLUMN "routing_error" TEXT,
  ADD COLUMN "observed_addresses" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "is_apex" BOOLEAN,
  ADD COLUMN "ssl_checked_at" TIMESTAMP(3),
  ADD COLUMN "ssl_valid_from" TIMESTAMP(3),
  ADD COLUMN "ssl_issuer" TEXT,
  ADD COLUMN "ssl_fingerprint256" TEXT,
  ADD COLUMN "ssl_failures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "ssl_provisioning_since" TIMESTAMP(3),
  ADD COLUMN "next_check_at" TIMESTAMP(3);

-- Repair 1: 'failed' was written for any resolver error (a timeout, a
-- SERVFAIL) and the only way out rotated the token. Nothing writes it any
-- more; such rows are simply still waiting for their record.
UPDATE "custom_domains"
SET "verification_status" = 'pending', "verification_error" = NULL
WHERE "verification_status" = 'failed';

-- Repair 2: every certificate status other than 'pending', every certificate
-- expiry and every is_active = true on this table was written by the timer,
-- not observed. One event per repaired domain says so in its history. The
-- event goes in first: the UPDATE below erases what identifies the rows.
INSERT INTO "domain_events" ("id", "domain_id", "event_type", "message", "previous_status", "new_status")
SELECT
  gen_random_uuid(),
  "id",
  'ssl_status_reset',
  'Earlier releases marked SSL active without issuing a certificate. The status was reset; it is now set only from a certificate observed on the domain.',
  "ssl_status",
  'pending'
FROM "custom_domains"
WHERE "ssl_status" <> 'pending' OR "ssl_expires_at" IS NOT NULL OR "is_active";

UPDATE "custom_domains"
SET "ssl_status" = 'pending',
    "ssl_expires_at" = NULL,
    "ssl_provider" = NULL,
    "ssl_error" = NULL,
    "is_active" = false
WHERE "ssl_status" <> 'pending'
   OR "ssl_expires_at" IS NOT NULL
   OR "ssl_provider" IS NOT NULL
   OR "is_active";

-- HTTPS is always enforced on a custom domain; plain-HTTP serving is not an
-- option, so no row may say otherwise.
UPDATE "custom_domains" SET "force_https" = true WHERE NOT "force_https";

-- A TXT record that was really looked up keeps its claim. Safe: domain was
-- globally unique until this migration, so no two rows can collide.
UPDATE "custom_domains"
SET "verified_domain" = "domain"
WHERE "verification_status" = 'verified';

-- Every live claim is due for its first real check.
UPDATE "custom_domains"
SET "next_check_at" = CURRENT_TIMESTAMP
WHERE "verification_status" <> 'expired';

CREATE UNIQUE INDEX "custom_domains_verified_domain_key" ON "custom_domains"("verified_domain");
CREATE INDEX "custom_domains_domain_idx" ON "custom_domains"("domain");
CREATE INDEX "custom_domains_next_check_at_idx" ON "custom_domains"("next_check_at");
