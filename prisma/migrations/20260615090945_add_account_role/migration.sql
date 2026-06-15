-- spec 020 v0.2 §2.3 — Account.role gate for admin write endpoints.
-- Default 1 (USER); existing rows backfilled to 1. The first ADMIN
-- account is created via `prisma db seed` (spec 020 §14 OQ #10).

-- spec 021 §4.3 step 3 — Prisma re-emits DROP INDEX for the pg_trgm GIN
-- indexes (spec 015 §4.2 hand-rolled, not visible to Prisma's introspector).
-- Drop the DROPs and reapply with CREATE INDEX IF NOT EXISTS at the tail.

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN "role" INTEGER NOT NULL DEFAULT 1;

-- ── pg_trgm GIN indexes re-assert (spec 015 §4.2) ──────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- charities (zh-TW)
CREATE INDEX IF NOT EXISTS "charities_name_trgm_idx"
  ON "charities" USING gin ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "charities_description_trgm_idx"
  ON "charities" USING gin ("description" gin_trgm_ops);

-- charities (en)
CREATE INDEX IF NOT EXISTS "charities_nameEn_trgm_idx"
  ON "charities" USING gin ("nameEn" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "charities_descriptionEn_trgm_idx"
  ON "charities" USING gin ("descriptionEn" gin_trgm_ops);

-- donation_projects (zh-TW)
CREATE INDEX IF NOT EXISTS "donation_projects_name_trgm_idx"
  ON "donation_projects" USING gin ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "donation_projects_description_trgm_idx"
  ON "donation_projects" USING gin ("description" gin_trgm_ops);

-- donation_projects (en)
CREATE INDEX IF NOT EXISTS "donation_projects_nameEn_trgm_idx"
  ON "donation_projects" USING gin ("nameEn" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "donation_projects_descriptionEn_trgm_idx"
  ON "donation_projects" USING gin ("descriptionEn" gin_trgm_ops);

-- sale_items (zh-TW)
CREATE INDEX IF NOT EXISTS "sale_items_name_trgm_idx"
  ON "sale_items" USING gin ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "sale_items_description_trgm_idx"
  ON "sale_items" USING gin ("description" gin_trgm_ops);

-- sale_items (en)
CREATE INDEX IF NOT EXISTS "sale_items_nameEn_trgm_idx"
  ON "sale_items" USING gin ("nameEn" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "sale_items_descriptionEn_trgm_idx"
  ON "sale_items" USING gin ("descriptionEn" gin_trgm_ops);
