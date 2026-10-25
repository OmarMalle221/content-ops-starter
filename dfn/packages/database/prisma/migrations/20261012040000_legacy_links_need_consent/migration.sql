-- Links created before the consent workflow (phase 6) were set by e-mail matching, without the
-- target's agreement. The phase 6 backfill kept them ACCEPTED; they become pending requests that the
-- target organisation must accept (or decline). Links accepted through the workflow always carry
-- the deciding user and are left untouched. The original request time is kept so that the
-- requester's daily request quota is not consumed by this migration.
UPDATE "Counterparty"
SET "linkStatus" = 'PENDING',
    "linkRequestedOrganizationId" = "linkedOrganizationId",
    "linkedOrganizationId" = NULL,
    "linkRequestedAt" = COALESCE("linkRequestedAt", "createdAt"),
    "linkDecidedAt" = NULL
WHERE "linkStatus" = 'ACCEPTED'
  AND "linkDecidedByUserId" IS NULL
  AND "linkedOrganizationId" IS NOT NULL;
