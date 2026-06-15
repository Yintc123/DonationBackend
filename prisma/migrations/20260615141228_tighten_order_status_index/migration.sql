-- spec 022 §4.7 — tighten the orders status/createdAt index with an id
-- tiebreaker matching the cursor sort `(createdAt DESC, id DESC)` used by
-- the admin list endpoint. PG can now serve the cursor query as a single
-- index scan without a sort step.

-- DropIndex
DROP INDEX "orders_status_createdAt_idx";

-- CreateIndex
CREATE INDEX "orders_status_createdAt_id_idx"
  ON "orders" ("status", "createdAt" DESC, "id" DESC);

-- spec 021 §4.3 step 3 — re-assert the pg_trgm GIN indexes Prisma's
-- introspector cannot see (it would emit DROP INDEX for them otherwise).
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
