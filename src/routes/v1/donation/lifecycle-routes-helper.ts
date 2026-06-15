// Spec 020 §5 / §7 — generic 4-action lifecycle route factory.
//
// Charity / DonationProject / SaleItem / Category each ship POST /archive,
// POST /unarchive, DELETE (soft), POST /restore. The handler bodies are
// identical modulo (a) the Prisma delegate, (b) the entity cache tag, and
// (c) the audit event name. We factored them here to remove ~80 lines of
// near-identical code from each admin route file.
//
// Lifecycle helpers expect a Prisma delegate matching the structural
// `LifecycleDelegate` in src/domain/donation-item/lifecycle-actions.ts. We
// don't tighten that type here — Charity / Project / SaleItem / Category
// all conform structurally.

import type { FastifyInstance } from 'fastify'
import { Type, type Static } from '@sinclair/typebox'

import {
  archive as lifecycleArchive,
  exists as lifecycleExists,
  restore as lifecycleRestore,
  softDelete as lifecycleSoftDelete,
  unarchive as lifecycleUnarchive,
} from '../../../domain/donation-item/lifecycle-actions.js'
import type { DonationEntity } from '../../../lib/cache/index.js'
import { NotFoundError } from '../../../lib/errors/index.js'
import { requireAdmin } from '../../../lib/auth/index.js'

const UUID_V4_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'

const IdParams = Type.Object({ id: Type.String({ pattern: UUID_V4_PATTERN }) })
type IdParamsT = Static<typeof IdParams>

export interface LifecycleRouteDeps<S extends Record<string, true>> {
  app: FastifyInstance
  basePath: string
  // The Prisma delegate to operate on. Use a loose `any` shape — TS would
  // require `Prisma.XDelegate` for each entity which doesn't compose. The
  // structural `LifecycleDelegate` in lifecycle-actions.ts is enforced
  // downstream.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delegate: any
  entity: DonationEntity
  // 404 contract.
  notFoundResource: string
  notFoundCode: string
  // Audit events emitted on actual transitions (spec 020 §12).
  auditPrefix: string // e.g. 'donation_charity'
  // dual-layer rate-limit config.
  rateLimit: { perUser: { limit: number; windowMs: number }; perIp: { limit: number; windowMs: number } }
  // Parent charity FK extractor (for cache cascading). Return null on missing
  // row so the route can emit 404 directly.
  loadParent?: (
    delegate: LifecycleRouteDeps<S>['delegate'],
    id: string,
  ) => Promise<{ parentCharityId: string } | null>
}

/**
 * Register the four lifecycle routes (archive / unarchive / delete /
 * restore) under `basePath`. Each handler:
 *   1. Calls `requireAdmin` (401 / 403 fail-safe).
 *   2. Reads parent charity id when applicable (project / sale).
 *   3. Verifies the row exists (404 with entity-specific code).
 *   4. Applies the lifecycle stamp via the shared factory (idempotent
 *      via WHERE clause; emits audit only on actual transition).
 */
export function registerLifecycleRoutes<S extends Record<string, true>>(
  deps: LifecycleRouteDeps<S>,
): void {
  const { app, basePath, delegate, entity, notFoundResource, notFoundCode, auditPrefix, rateLimit, loadParent } =
    deps

  async function resolveExistsAndParent(id: string): Promise<{ parentCharityId?: string }> {
    if (loadParent) {
      const parent = await loadParent(delegate, id)
      if (parent === null) {
        throw new NotFoundError({ resource: notFoundResource, id, code: notFoundCode })
      }
      return { parentCharityId: parent.parentCharityId }
    }
    if (!(await lifecycleExists(delegate, id))) {
      throw new NotFoundError({ resource: notFoundResource, id, code: notFoundCode })
    }
    return {}
  }

  const action = (suffix: '/archive' | '/unarchive' | '' | '/restore', method: 'POST' | 'DELETE', handler: typeof lifecycleArchive, event: string) => {
    app.route<{ Params: IdParamsT }>({
      method,
      url: `${basePath}/:id${suffix}`,
      schema: { params: IdParams },
      config: { rateLimit },
      handler: async (req, reply) => {
        await requireAdmin(req, app.prisma, app.tokenSecrets)
        const id = req.params.id
        const { parentCharityId } = await resolveExistsAndParent(id)
        await handler(
          delegate,
          { redis: app.redis, logger: req.log, now: app.clock() },
          { entity, id, parentCharityId, auditEvent: `${auditPrefix}_${event}` },
        )
        return reply.noContent()
      },
    })
  }

  action('/archive', 'POST', lifecycleArchive, 'archived')
  action('/unarchive', 'POST', lifecycleUnarchive, 'unarchived')
  action('', 'DELETE', lifecycleSoftDelete, 'deleted')
  action('/restore', 'POST', lifecycleRestore, 'restored')
}
