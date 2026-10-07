-- Custom domains: the certificate issuance budget, and a fair checker batch.
--
-- Every "yes" the API gives the edge about a hostname without a certificate
-- makes the edge open an order on the platform's one account with the
-- certificate authority. Each such "yes" is recorded here, and the next one is
-- refused once the name, its organization or the platform has used its share
-- of the window (services/customDomainRules.ts decideIssuanceBudget).
--
-- A grant deliberately has no foreign key to custom_domains: deleting a domain
-- and adding a fresh name must not hand the organization its budget back.
-- Rows are short-lived; the grant statement removes those older than a day.

CREATE TABLE "custom_domain_issuance_grants" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_domain_issuance_grants_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "custom_domain_issuance_grants_granted_at_idx" ON "custom_domain_issuance_grants"("granted_at");
CREATE INDEX "custom_domain_issuance_grants_org_id_granted_at_idx" ON "custom_domain_issuance_grants"("org_id", "granted_at");
CREATE INDEX "custom_domain_issuance_grants_domain_granted_at_idx" ON "custom_domain_issuance_grants"("domain", "granted_at");

-- The checker takes each organization's oldest due rows separately, so that
-- one organization cannot fill a batch.
CREATE INDEX "custom_domains_org_id_next_check_at_idx" ON "custom_domains"("org_id", "next_check_at");
