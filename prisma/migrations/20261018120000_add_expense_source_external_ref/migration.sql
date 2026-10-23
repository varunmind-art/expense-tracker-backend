-- Provenance and idempotency for expenses created by the Android companion app.
-- Nullable and additive: every existing row is unaffected, and the unique index
-- only constrains rows that actually carry both a source and an external ref.
ALTER TABLE "Expense" ADD COLUMN "source" TEXT;
ALTER TABLE "Expense" ADD COLUMN "externalRef" TEXT;

CREATE UNIQUE INDEX "Expense_userId_source_externalRef_key"
    ON "Expense"("userId", "source", "externalRef");
