-- CreateTable
CREATE TABLE "charities" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "nameEn" VARCHAR(120),
    "descriptionEn" VARCHAR(500),
    "logoKey" VARCHAR(512),
    "contactPhone" VARCHAR(40),
    "contactEmail" VARCHAR(254),
    "officialWebsite" VARCHAR(2048),
    "approvalNo" VARCHAR(80),
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "publishStartAt" TIMESTAMP(3),
    "publishEndAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "charities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "donation_projects" (
    "id" TEXT NOT NULL,
    "charityId" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "nameEn" VARCHAR(120),
    "descriptionEn" VARCHAR(500),
    "logoKey" VARCHAR(512),
    "coverImageKey" VARCHAR(512),
    "content" TEXT NOT NULL,
    "contentEn" TEXT,
    "raisingApprovalNo" VARCHAR(80),
    "reliefApprovalNo" VARCHAR(80),
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "publishStartAt" TIMESTAMP(3),
    "publishEndAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "donation_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_items" (
    "id" TEXT NOT NULL,
    "charityId" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "nameEn" VARCHAR(120),
    "descriptionEn" VARCHAR(500),
    "logoKey" VARCHAR(512),
    "coverImageKey" VARCHAR(512),
    "priceTwd" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "contentEn" TEXT,
    "raisingApprovalNo" VARCHAR(80),
    "reliefApprovalNo" VARCHAR(80),
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "publishStartAt" TIMESTAMP(3),
    "publishEndAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sale_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "displayName" VARCHAR(80) NOT NULL,
    "displayNameEn" VARCHAR(80),
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charity_categories" (
    "charityId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "charity_categories_pkey" PRIMARY KEY ("charityId","categoryId")
);

-- CreateIndex
CREATE INDEX "charities_displayOrder_createdAt_id_idx" ON "charities"("displayOrder", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "charities_publishEndAt_idx" ON "charities"("publishEndAt");

-- CreateIndex
CREATE INDEX "charities_createdAt_id_idx" ON "charities"("createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "donation_projects_charityId_idx" ON "donation_projects"("charityId");

-- CreateIndex
CREATE INDEX "donation_projects_charityId_displayOrder_createdAt_id_idx" ON "donation_projects"("charityId", "displayOrder", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "donation_projects_publishEndAt_idx" ON "donation_projects"("publishEndAt");

-- CreateIndex
CREATE INDEX "donation_projects_createdAt_id_idx" ON "donation_projects"("createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "sale_items_charityId_idx" ON "sale_items"("charityId");

-- CreateIndex
CREATE INDEX "sale_items_charityId_displayOrder_createdAt_id_idx" ON "sale_items"("charityId", "displayOrder", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "sale_items_publishEndAt_idx" ON "sale_items"("publishEndAt");

-- CreateIndex
CREATE INDEX "sale_items_createdAt_id_idx" ON "sale_items"("createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "categories_key_key" ON "categories"("key");

-- CreateIndex
CREATE INDEX "categories_displayOrder_idx" ON "categories"("displayOrder");

-- CreateIndex
CREATE INDEX "charity_categories_categoryId_idx" ON "charity_categories"("categoryId");

-- AddForeignKey
ALTER TABLE "donation_projects" ADD CONSTRAINT "donation_projects_charityId_fkey" FOREIGN KEY ("charityId") REFERENCES "charities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_charityId_fkey" FOREIGN KEY ("charityId") REFERENCES "charities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charity_categories" ADD CONSTRAINT "charity_categories_charityId_fkey" FOREIGN KEY ("charityId") REFERENCES "charities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charity_categories" ADD CONSTRAINT "charity_categories_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── pg_trgm extension + GIN indexes (spec 015 §4.2) ─────────────────────────
-- Prisma DSL cannot express GIN trigram indexes. Append manually per
-- spec 015's migration plan (§9.1).

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
