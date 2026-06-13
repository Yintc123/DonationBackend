import { defineWorkspace } from 'vitest/config'

// Spec 013 §4 — three-project workspace.
// - unit:        co-located with src/, no container, fast
// - integration: tests/integration/, real Postgres + Redis via testcontainers
// - e2e:         tests/e2e/, full HTTP flows, MSW for Google OAuth
//
// During scaffold each project ships a sanity test that asserts only the
// in-process wiring (config load, transform, setup chain) — they exit green
// without Docker. Replace with real tests as features land.
export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['src/**/*.test.ts'],
      environment: 'node',
      testTimeout: 5_000,
    },
  },
  {
    test: {
      name: 'integration',
      include: ['tests/integration/**/*.test.ts'],
      environment: 'node',
      testTimeout: 30_000,
      globalSetup: ['tests/setup/global-setup.ts'],
      setupFiles: ['tests/setup/per-test-setup.ts'],
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
      maxConcurrency: 1,
    },
  },
  {
    test: {
      name: 'e2e',
      include: ['tests/e2e/**/*.test.ts'],
      environment: 'node',
      testTimeout: 60_000,
      globalSetup: ['tests/setup/global-setup.ts'],
      setupFiles: ['tests/setup/per-test-setup.ts'],
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
      maxConcurrency: 1,
    },
  },
])
