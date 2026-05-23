import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, statSync } from 'node:fs';
import { runClaude, type ClaudeRunnerSpawn, type RunRequest } from './runner.js';
import { extractBearer, verifyToken } from './auth.js';

const MAX_BYTES = Number(process.env.CLAUDE_MAX_REQUEST_BYTES ?? 2 * 1024 * 1024);

export interface BuildServerOpts {
  sharedToken: string;
  spawn?: ClaudeRunnerSpawn;        // for tests
}

export function buildServer(opts: BuildServerOpts): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: MAX_BYTES });

  app.setErrorHandler((err, _req, reply) => {
    if (err.statusCode === 413) {
      reply.code(413).send({ error: 'payload_too_large' });
      return;
    }
    reply.code(500).send({ error: 'internal_error', detail: err.message });
  });

  app.post('/chat', async (req, reply) => {
    const token = extractBearer(req.headers.authorization);
    if (!verifyToken(opts.sharedToken, token)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const body = req.body as Partial<RunRequest> | undefined;
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      return reply.code(400).send({ error: 'bad_request', detail: 'messages required' });
    }
    if (body.cwd) {
      if (!existsSync(body.cwd) || !statSync(body.cwd).isDirectory()) {
        return reply.code(400).send({ error: 'bad_request', detail: 'cwd not a directory' });
      }
    }

    const ctrl = new AbortController();
    req.raw.on('close', () => ctrl.abort());

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    });

    const stream = runClaude(body as RunRequest, ctrl.signal, { spawn: opts.spawn });
    stream.pipe(reply.raw);

    // Prevent fastify from auto-replying — we manage the response stream.
    return reply;
  });

  return app;
}

// CLI entry — only when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const sharedToken = process.env.BRIDGE_SHARED_TOKEN;
  if (!sharedToken) {
    console.error('BRIDGE_SHARED_TOKEN is required');
    process.exit(1);
  }
  const port = Number(process.env.CLAUDE_SERVICE_PORT ?? 7842);
  const app = buildServer({ sharedToken });
  app.listen({ port, host: '0.0.0.0' }).then(() => {
    console.log(`claude-service listening on :${port}`);
  });
}
