// Spec 020 §5.2 — DonationProject admin write services.
//
// Same shape as charity-write.ts; the differences are:
//   - parent FK to Charity (must exist, but archived parent is OK — admin
//     workflow per spec 020 §5.2)
//   - no categoryIds (Project doesn't have its own categories — they
//     inherit from parent Charity via the nested-charity view)
//   - coverImageKey field
//   - cache cascading goes through parentCharityId.

import type { DonationProject, Prisma, PrismaClient } from '@prisma/client'
import type { FastifyBaseLogger } from 'fastify'
import type { Redis } from 'ioredis'

import { BadRequestError, ErrorCode, NotFoundError } from '../../lib/errors/index.js'
import { invalidateDonationEntity } from '../../lib/cache/invalidate-donation.js'
import { assertValidObjectKey } from '../../lib/s3/index.js'
import type { Clock } from '../../lib/clock.js'
import { type Locale, pickLocalised } from '../../lib/i18n/index.js'

import type { ProjectDetailT } from '../../schemas/donation-item/detail.js'

type ObjectUrl = (key: string) => string

export interface ProjectWriteDeps {
  prisma: PrismaClient
  redis: Redis
  logger: FastifyBaseLogger
  clock: Clock
  locale: Locale
  objectUrl: ObjectUrl
}

export interface ProjectCreateInput {
  charityId: string
  name: string
  description: string
  content: string
  nameEn?: string | null
  descriptionEn?: string | null
  contentEn?: string | null
  logoKey?: string | null
  coverImageKey?: string | null
  raisingApprovalNo?: string | null
  reliefApprovalNo?: string | null
  displayOrder?: number
  publishStartAt?: string | null
  publishEndAt?: string | null
}

export interface ProjectPatchInput {
  name?: string
  description?: string
  content?: string
  nameEn?: string | null
  descriptionEn?: string | null
  contentEn?: string | null
  logoKey?: string | null
  coverImageKey?: string | null
  raisingApprovalNo?: string | null
  reliefApprovalNo?: string | null
  displayOrder?: number
  publishStartAt?: string | null
  publishEndAt?: string | null
}

// ── Shared helpers (mirroring charity-write.ts) ────────────────────────────

function assertPublishRange(start: string | null | undefined, end: string | null | undefined): void {
  if (start == null || end == null) return
  if (new Date(start) >= new Date(end)) {
    throw new BadRequestError({
      code: ErrorCode.INVALID_LIFECYCLE_RANGE,
      message: 'publishStartAt must be strictly before publishEndAt',
    })
  }
}

function assertImageKeys(input: { logoKey?: string | null; coverImageKey?: string | null }): void {
  if (input.logoKey != null) assertValidObjectKey(input.logoKey, '/logoKey')
  if (input.coverImageKey != null) assertValidObjectKey(input.coverImageKey, '/coverImageKey')
}

async function assertParentCharityExists(
  prisma: Prisma.TransactionClient | PrismaClient,
  charityId: string,
): Promise<void> {
  // Spec 020 §5.2: parent must exist; archived/deleted parent is permitted
  // (admin can attach a project to an archived charity for retention).
  const parent = await prisma.charity.findUnique({
    where: { id: charityId },
    select: { id: true },
  })
  if (parent === null) {
    throw new NotFoundError({
      resource: 'charity',
      id: charityId,
      code: ErrorCode.CHARITY_NOT_FOUND,
    })
  }
}

function parseDate(iso: string | null | undefined): Date | null | undefined {
  if (iso === undefined) return undefined
  if (iso === null) return null
  return new Date(iso)
}

interface HydratedProjectRow {
  project: DonationProject & {
    charity: {
      id: string
      name: string
      nameEn: string | null
      logoKey: string | null
      categories: {
        category: { id: string; key: string; displayName: string; displayNameEn: string | null }
      }[]
    }
  }
}

function buildResponse(deps: ProjectWriteDeps, row: HydratedProjectRow): ProjectDetailT {
  const p = row.project
  return {
    id: p.id,
    name: pickLocalised(deps.locale, { zh: p.name, en: p.nameEn }),
    description: pickLocalised(deps.locale, { zh: p.description, en: p.descriptionEn }),
    logoUrl: p.logoKey ? deps.objectUrl(p.logoKey) : null,
    coverImageUrl: p.coverImageKey ? deps.objectUrl(p.coverImageKey) : null,
    content: pickLocalised(deps.locale, { zh: p.content, en: p.contentEn }),
    raisingApprovalNo: p.raisingApprovalNo,
    reliefApprovalNo: p.reliefApprovalNo,
    charity: {
      id: p.charity.id,
      name: pickLocalised(deps.locale, { zh: p.charity.name, en: p.charity.nameEn }),
      logoUrl: p.charity.logoKey ? deps.objectUrl(p.charity.logoKey) : null,
    },
    categories: p.charity.categories.map((cc) => ({
      id: cc.category.id,
      key: cc.category.key,
      displayName: pickLocalised(deps.locale, {
        zh: cc.category.displayName,
        en: cc.category.displayNameEn,
      }),
    })),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }
}

async function loadHydrated(
  prisma: Prisma.TransactionClient | PrismaClient,
  id: string,
): Promise<HydratedProjectRow | null> {
  const row = await prisma.donationProject.findUnique({
    where: { id },
    include: {
      charity: {
        include: {
          categories: {
            where: { category: { deletedAt: null, archivedAt: null } },
            include: { category: true },
            orderBy: { category: { displayOrder: 'asc' } },
          },
        },
      },
    },
  })
  if (row === null) return null
  return { project: row }
}

// ── createProject (spec 020 §5.2) ──────────────────────────────────────────

export async function createProject(
  deps: ProjectWriteDeps,
  input: ProjectCreateInput,
): Promise<ProjectDetailT> {
  assertPublishRange(input.publishStartAt, input.publishEndAt)
  assertImageKeys(input)
  await assertParentCharityExists(deps.prisma, input.charityId)

  const created = await deps.prisma.donationProject.create({
    data: {
      charityId: input.charityId,
      name: input.name,
      description: input.description,
      content: input.content,
      nameEn: input.nameEn ?? null,
      descriptionEn: input.descriptionEn ?? null,
      contentEn: input.contentEn ?? null,
      logoKey: input.logoKey ?? null,
      coverImageKey: input.coverImageKey ?? null,
      raisingApprovalNo: input.raisingApprovalNo ?? null,
      reliefApprovalNo: input.reliefApprovalNo ?? null,
      displayOrder: input.displayOrder ?? 0,
      publishStartAt: parseDate(input.publishStartAt) ?? undefined,
      publishEndAt: parseDate(input.publishEndAt) ?? undefined,
    },
  })

  const hydrated = await loadHydrated(deps.prisma, created.id)
  if (hydrated === null) {
    throw new Error('createProject: row vanished immediately after create')
  }

  await invalidateDonationEntity({
    redis: deps.redis,
    logger: deps.logger,
    entity: 'project',
    id: hydrated.project.id,
    parentCharityId: hydrated.project.charityId,
  })
  deps.logger.info({
    event: 'donation_project_created',
    entityId: hydrated.project.id,
    audit: true,
  })

  return buildResponse(deps, hydrated)
}

// ── updateProject (spec 020 §5.2) ──────────────────────────────────────────

export async function updateProject(
  deps: ProjectWriteDeps,
  id: string,
  input: ProjectPatchInput,
): Promise<ProjectDetailT> {
  assertPublishRange(input.publishStartAt, input.publishEndAt)
  assertImageKeys(input)

  const existing = await deps.prisma.donationProject.findUnique({
    where: { id },
    select: { id: true, charityId: true },
  })
  if (existing === null) {
    throw new NotFoundError({
      resource: 'donation-project',
      id,
      code: ErrorCode.DONATION_PROJECT_NOT_FOUND,
    })
  }

  await deps.prisma.donationProject.update({
    where: { id },
    data: {
      name: input.name,
      description: input.description,
      content: input.content,
      nameEn: input.nameEn,
      descriptionEn: input.descriptionEn,
      contentEn: input.contentEn,
      logoKey: input.logoKey,
      coverImageKey: input.coverImageKey,
      raisingApprovalNo: input.raisingApprovalNo,
      reliefApprovalNo: input.reliefApprovalNo,
      displayOrder: input.displayOrder,
      publishStartAt: parseDate(input.publishStartAt),
      publishEndAt: parseDate(input.publishEndAt),
    },
  })

  const hydrated = await loadHydrated(deps.prisma, id)
  if (hydrated === null) {
    throw new Error('updateProject: row vanished post-update')
  }

  await invalidateDonationEntity({
    redis: deps.redis,
    logger: deps.logger,
    entity: 'project',
    id: hydrated.project.id,
    parentCharityId: hydrated.project.charityId,
  })
  deps.logger.info({
    event: 'donation_project_updated',
    entityId: hydrated.project.id,
    audit: true,
  })

  return buildResponse(deps, hydrated)
}
