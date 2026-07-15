-- Existing and newly registered machines remain student-visible unless an
-- administrator explicitly hides them.
ALTER TABLE "machines"
ADD COLUMN "is_hidden" BOOLEAN NOT NULL DEFAULT false
CHECK ("is_hidden" IN (0, 1));
