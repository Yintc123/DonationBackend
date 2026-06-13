import Fastify from 'fastify'

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
})

fastify.get('/health', async () => {
  return { status: 'ok' }
})

const start = async () => {
  try {
    const port = Number(process.env.PORT ?? 3001)
    const host = process.env.HOST ?? '0.0.0.0'
    await fastify.listen({ port, host })
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

start()
