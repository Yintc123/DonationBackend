-- Spec 007 §10.2 / spec 008 §5.4 — add interactive-login audit fields to
-- `accounts`. Both columns nullable: existing accounts read as "never
-- logged in" instead of fake-now.

-- CreateEnum
CREATE TYPE "LoginType" AS ENUM ('PASSWORD', 'GOOGLE');

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN "lastLoginAt" TIMESTAMP(3),
                       ADD COLUMN "lastLoginType" "LoginType";

-- ─── Re-assert pg_trgm GIN indexes (spec 015 §4.2) ──────────────────────────
-- Prisma's diff engine doesn't model GIN trigram operator classes, so when
-- generating this migration it proposed dropping the indexes created in
-- 20260614052843_add_donation_items_with_categories. We override that
-- behaviour by NOT including the DROP statements and re-asserting the
-- indexes with IF NOT EXISTS so the migration is a no-op against any
-- environment where the indexes already exist (prod, staging).
-- In a fresh dev DB after `prisma migrate reset` these create them
-- alongside the donation tables — same end state.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "charities_name_trgm_idx"
  ON "charities" USING gin ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "charities_description_trgm_idx"
  ON "charities" USING gin ("description" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "charities_nameEn_trgm_idx"
  ON "charities" USING gin ("nameEn" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "charities_descriptionEn_trgm_idx"
  ON "charities" USING gin ("descriptionEn" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "donation_projects_name_trgm_idx"
  ON "donation_projects" USING gin ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "donation_projects_description_trgm_idx"
  ON "donation_projects" USING gin ("description" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "donation_projects_nameEn_trgm_idx"
  ON "donation_projects" USING gin ("nameEn" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "donation_projects_descriptionEn_trgm_idx"
  ON "donation_projects" USING gin ("descriptionEn" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "sale_items_name_trgm_idx"
  ON "sale_items" USING gin ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "sale_items_description_trgm_idx"
  ON "sale_items" USING gin ("description" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "sale_items_nameEn_trgm_idx"
  ON "sale_items" USING gin ("nameEn" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "sale_items_descriptionEn_trgm_idx"
  ON "sale_items" USING gin ("descriptionEn" gin_trgm_ops);
