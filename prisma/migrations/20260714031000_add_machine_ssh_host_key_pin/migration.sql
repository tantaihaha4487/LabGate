ALTER TABLE "machines" ADD COLUMN "ssh_host_key_sha256" TEXT;

CREATE UNIQUE INDEX "machines_ssh_host_key_sha256_key"
ON "machines"("ssh_host_key_sha256");
