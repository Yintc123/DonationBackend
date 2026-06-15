-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'PAID', 'CANCELLED', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "OrderSubjectType" AS ENUM ('CHARITY', 'DONATION_PROJECT', 'SALE_ITEM');

-- CreateEnum
CREATE TYPE "DonationFrequency" AS ENUM ('ONE_TIME', 'RECURRING');

-- CreateEnum
CREATE TYPE "BillingDay" AS ENUM ('DAY_6', 'DAY_16', 'DAY_26');

-- CreateEnum
CREATE TYPE "ReceiptOption" AS ENUM ('NONE', 'INDIVIDUAL', 'CORPORATE', 'GOVERNMENT_DONATION', 'DEFER');

-- spec 021 §4.3 step 3 — Prisma 在 introspect 時看不到 pg_trgm GIN indexes
-- (spec 015 §4.2 手寫),因此會在此處 emit 12 行 DROP INDEX。一律刪除,
-- 並於尾段以 CREATE INDEX IF NOT EXISTS 重宣告(同 spec 020 v0.4 / spec 008 處理慣例)。

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "donorName" VARCHAR(120) NOT NULL,
    "isAnonymous" BOOLEAN NOT NULL DEFAULT false,
    "receiptOption" "ReceiptOption",
    "note" VARCHAR(500),
    "nextChargeAt" TIMESTAMP(3),
    "amountTwd" INTEGER NOT NULL,
    "paidAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_lines" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "subjectType" "OrderSubjectType" NOT NULL,
    "charityId" TEXT,
    "donationProjectId" TEXT,
    "saleItemId" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPriceTwd" INTEGER NOT NULL,
    "subtotalTwd" INTEGER NOT NULL,
    "donationFrequency" "DonationFrequency",
    "billingDay" "BillingDay",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "orders_status_createdAt_idx" ON "orders"("status", "createdAt");

-- CreateIndex
CREATE INDEX "orders_nextChargeAt_idx" ON "orders"("nextChargeAt");

-- CreateIndex
CREATE INDEX "order_lines_orderId_idx" ON "order_lines"("orderId");

-- CreateIndex
CREATE INDEX "order_lines_charityId_idx" ON "order_lines"("charityId");

-- CreateIndex
CREATE INDEX "order_lines_donationProjectId_idx" ON "order_lines"("donationProjectId");

-- CreateIndex
CREATE INDEX "order_lines_saleItemId_idx" ON "order_lines"("saleItemId");

-- CreateIndex
CREATE INDEX "order_lines_subjectType_createdAt_idx" ON "order_lines"("subjectType", "createdAt");

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_charityId_fkey" FOREIGN KEY ("charityId") REFERENCES "charities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_donationProjectId_fkey" FOREIGN KEY ("donationProjectId") REFERENCES "donation_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_saleItemId_fkey" FOREIGN KEY ("saleItemId") REFERENCES "sale_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── pg_trgm GIN indexes re-assert (spec 015 §4.2 + spec 021 §4.3) ───────────
-- Prisma stripped these in the auto-generated DROP INDEX section above (it
-- has no awareness of GIN trigram indexes); reapply with IF NOT EXISTS so
-- this migration is idempotent across fresh DBs and existing DBs that
-- already carry these indexes from the spec 015 / spec 020 migrations.

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
