// Spec 013 §5 — testcontainers helper.
//
// Implemented tiers:
//   - Redis:    new GenericContainer('redis:7-alpine').withExposedPorts(6379)
//   - Postgres: PostgreSqlContainer('postgres:16-alpine')
//
// Lifecycle is owned by tests/setup/global-setup.ts.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'

export interface PostgresInfo {
  connectionUri: string
  host: string
  port: number
  user: string
  password: string
  database: string
}

export interface LocalStackInfo {
  endpoint: string
  bucket: string
}

export interface RedisInfo {
  host: string
  port: number
}

export interface TestContainers {
  postgres: PostgresInfo
  redis: RedisInfo
  localstack: LocalStackInfo
  stop: () => Promise<void>
}

const TEST_BUCKET = 'test-assets'

export async function startContainers(): Promise<TestContainers> {
  const [redisContainer, pgContainer, lsContainer] = await Promise.all([
    new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new GenericContainer('localstack/localstack:3')
      .withExposedPorts(4566)
      .withEnvironment({ SERVICES: 's3', DEBUG: '0', EAGER_SERVICE_LOADING: '1' })
      .withWaitStrategy(Wait.forLogMessage(/Ready\./, 1))
      .withStartupTimeout(60_000)
      .start(),
  ])

  const redisInfo = buildRedisInfo(redisContainer)
  const postgresInfo = buildPostgresInfo(pgContainer)
  const localstackInfo = await bootstrapLocalStack(lsContainer)

  return {
    postgres: postgresInfo,
    redis: redisInfo,
    localstack: localstackInfo,
    stop: async () => {
      await Promise.all([
        redisContainer.stop(),
        pgContainer.stop(),
        lsContainer.stop(),
      ])
    },
  }
}

async function bootstrapLocalStack(c: StartedTestContainer): Promise<LocalStackInfo> {
  const endpoint = `http://${c.getHost()}:${c.getMappedPort(4566).toString()}`

  // Spec 018 §9.3 — same idempotent bootstrap that the dev script does.
  // We dynamically import to keep the startup cost off the unit-test path.
  const { S3Client, CreateBucketCommand, PutBucketPolicyCommand, PutBucketCorsCommand } =
    await import('@aws-sdk/client-s3')

  const client = new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  })

  try {
    await client.send(new CreateBucketCommand({ Bucket: TEST_BUCKET }))
  } catch (err: unknown) {
    // BucketAlreadyOwnedByYou is fine on container reuse.
    if (
      !(err instanceof Error) ||
      !/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(err.name + err.message)
    ) {
      throw err
    }
  }

  await client.send(
    new PutBucketPolicyCommand({
      Bucket: TEST_BUCKET,
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: '*',
            Action: 's3:GetObject',
            Resource: `arn:aws:s3:::${TEST_BUCKET}/*`,
          },
        ],
      }),
    }),
  )

  await client.send(
    new PutBucketCorsCommand({
      Bucket: TEST_BUCKET,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: ['http://localhost:3000'],
            AllowedMethods: ['PUT', 'GET', 'HEAD'],
            AllowedHeaders: ['*'],
            ExposeHeaders: ['ETag'],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    }),
  )

  client.destroy()
  return { endpoint, bucket: TEST_BUCKET }
}

function buildRedisInfo(c: StartedTestContainer): RedisInfo {
  return { host: c.getHost(), port: c.getMappedPort(6379) }
}

function buildPostgresInfo(c: StartedPostgreSqlContainer): PostgresInfo {
  const host = c.getHost()
  const port = c.getMappedPort(5432)
  const user = c.getUsername()
  const password = c.getPassword()
  const database = c.getDatabase()
  return {
    host,
    port,
    user,
    password,
    database,
    connectionUri: `postgresql://${user}:${password}@${host}:${port.toString()}/${database}?schema=public`,
  }
}
