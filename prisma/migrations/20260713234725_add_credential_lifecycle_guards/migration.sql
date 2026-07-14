-- AlterTable
ALTER TABLE "guest_credentials" ADD COLUMN "session_opened_at" DATETIME;
ALTER TABLE "guest_credentials" ADD COLUMN "machine_state_version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "machines" ADD COLUMN "safety_hold_credential_id" TEXT;

-- A legacy revoked row is terminal. This prevents a delayed historical open
-- webhook from resurrecting a credential after the upgrade.
UPDATE "guest_credentials"
SET "machine_state_version" = 3
WHERE "revoked_at" IS NOT NULL;

-- One physical host must have exactly one database identity.
CREATE UNIQUE INDEX "machines_name_key" ON "machines"("name");
CREATE UNIQUE INDEX "machines_tailscale_ip_key" ON "machines"("tailscale_ip");

-- CreateIndex
CREATE UNIQUE INDEX "guest_credentials_active_machine_key"
ON "guest_credentials"("machine_id")
WHERE "revoked_at" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "guest_credentials_active_student_email_key"
ON "guest_credentials"(LOWER("student_email"))
WHERE "revoked_at" IS NULL;
