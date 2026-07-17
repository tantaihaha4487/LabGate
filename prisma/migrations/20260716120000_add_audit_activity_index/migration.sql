-- Stable newest-first activity pagination must remain indexed as the audit log grows.
CREATE INDEX "audit_log_created_at_id_idx"
ON "audit_log"("created_at", "id");
