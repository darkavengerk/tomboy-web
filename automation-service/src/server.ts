import Fastify, { type FastifyInstance } from 'fastify';
import { extractBearer, verifyToken } from './auth.js';
import { loadRegistry, lookupCommand, type Registry } from './registry.js';
import { runEntries, type RunnerOpts } from './runner.js';

const MAX_BYTES = Number(process.env.AUTOMATION_MAX_REQUEST_BYTES ?? 64 * 1024);

export interface BuildServerOpts {
  sharedToken: string;
  registry: Registry;
  runnerOpts?: RunnerOpts;
}

export function buildServer(opts: BuildServerOpts): FastifyInstance {
  const app = Fastify({ logger: true, bodyLimit: MAX_BYTES });

  app.post('/run', async (req, reply) => {
    const token = extractBearer(req.headers.authorization);
    if (!verifyToken(opts.sharedToken, token)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const body = req.body as { command?: unknown } | undefined;
    if (!body || typeof body.command !== 'string' || !body.command) {
      return reply.code(400).send({ error: 'bad_request', detail: 'command required' });
    }
    const entries = lookupCommand(opts.registry, body.command);
    if (!entries) {
      return reply.code(400).send({ error: 'unknown_command', detail: body.command });
    }
    const out = await runEntries(entries, opts.runnerOpts);
    return reply.code(200).send(out);
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sharedToken = process.env.BRIDGE_SHARED_TOKEN;
  if (!sharedToken) { console.error('BRIDGE_SHARED_TOKEN is required'); process.exit(1); }
  const configPath = process.env.AUTOMATION_CONFIG ?? `${process.env.HOME}/.config/tomboy-automation.json`;
  const registry = loadRegistry(configPath);
  const runnerOpts: RunnerOpts = {
    timeoutMs: Number(process.env.AUTOMATION_TIMEOUT_MS ?? 30_000),
    maxOutputBytes: Number(process.env.AUTOMATION_MAX_OUTPUT_BYTES ?? 5 * 1024 * 1024)
  };
  const port = Number(process.env.AUTOMATION_SERVICE_PORT ?? 7843);
  const app = buildServer({ sharedToken, registry, runnerOpts });
  app.listen({ port, host: '0.0.0.0' }).then(() => console.log(`automation-service on :${port}`));
}
