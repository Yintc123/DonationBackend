-- Spec 007 §10.1 / §10.9 (v0.4) — Account identity & lifecycle extensions.
--
-- Identifier model:
--   - Add `username TEXT NULL @unique` as the primary identifier for
--     password-based registration. Both `username` and `email` are
--     nullable to support multiple registration paths additively:
--       - Password register → username always set, email optional
--       - Google sign-in (new account) → email always set, username null
--     App layer guarantees "at least one identifier" at registration time.
--   - DROP NOT NULL on `email` so Google-only accounts may later be
--     username-only too (current path keeps email).
--
-- Lifecycle columns (spec 007 §10.9):
--   - `displayOrder INT NOT NULL DEFAULT 0` for future admin user-list UI;
--     no domain semantics today.
--   - `archivedAt TIMESTAMP(3) NULL` / `deletedAt TIMESTAMP(3) NULL` —
--     EITHER non-null means "account disabled". /auth/login, /auth/refresh,
--     /auth/google/exchange (login intent) all reject with 401
--     AUTH_ACCOUNT_DISABLED. /auth/password/change | /auth/password/set |
--     /auth/google/exchange link intent are also blocked (caller's JWT may
--     have been issued before the disable). Existing JWTs are NOT
--     pre-emptively revoked from Redis; the per-request check on /refresh
--     catches them on next use.

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "archivedAt"   TIMESTAMP(3),
                       ADD COLUMN     "deletedAt"    TIMESTAMP(3),
                       ADD COLUMN     "displayOrder" INTEGER NOT NULL DEFAULT 0,
                       ADD COLUMN     "username"     TEXT,
                       ALTER COLUMN   "email"        DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "accounts_username_key" ON "accounts"("username");

-- ─── Re-assert pg_trgm GIN indexes (spec 015 §4.2) ──────────────────────────
-- Same reason as 20260615040538_add_account_last_login: Prisma's diff
-- engine doesn't model GIN trigram operator classes and proposes dropping
-- them. We strip those drops and re-assert with IF NOT EXISTS for safety
-- across all environments.

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
