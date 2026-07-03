import Fastify, { type FastifyInstance } from 'fastify';
import { runClaude, type ClaudeRunnerSpawn, type RunRequest } from './runner.js';
import { extractBearer, verifyToken } from './auth.js';
import { inlineImageUrls, ImageFetchError, type FetchFn } from './imageInline.js';

// 16 MiB — 클라가 큰 이미지를 다운스케일 후 base64로 인라인해 보냄 (브릿지 readJson MAX와 맞춤)
const MAX_BYTES = Number(process.env.CLAUDE_MAX_REQUEST_BYTES ?? 16 * 1024 * 1024);

export interface BuildServerOpts {
  sharedToken: string;
  spawn?: ClaudeRunnerSpawn;        // for tests
  fetchImage?: FetchFn;             // for tests (inlineImageUrls)
}

export function buildServer(opts: BuildServerOpts): FastifyInstance {
  const app = Fastify({ logger: true, bodyLimit: MAX_BYTES });

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
    // Diagnostic line: messages × content block types per turn, so silent
    // image-fail / oversized-payload cases are visible in journalctl.
    const shape = body.messages
      .map((m) => `${m.role}[${m.content.map((c) => c.type).join(',')}]`)
      .join(' ');
    req.log.info(
      { messages: body.messages.length, shape, model: body.model, effort: body.effort ?? null },
      'chat request',
    );

    // Inline image-url blocks as base64 BEFORE spawning claude.
    // Anthropic's url-source fetcher honors robots.txt, which blocks
    // Dropbox `/scl/...` paths; sending base64 bypasses that. Token cost
    // is unchanged (Anthropic prices images by dimensions, not bytes).
    let runMessages: RunRequest['messages'];
    try {
      runMessages = await inlineImageUrls(body.messages, { fetchFn: opts.fetchImage });
    } catch (err) {
      if (err instanceof ImageFetchError) {
        return reply
          .code(502)
          .send({ error: 'image_fetch_failed', detail: err.message });
      }
      throw err;
    }

    const ctrl = new AbortController();
    // Watch the RESPONSE socket for disconnect, not req.raw.
    // req.raw 'close' fires as soon as the request body is fully read —
    // which for a small JSON POST happens immediately, before we've
    // even started the response. Aborting on req.close kills the child
    // process before claude can produce any output. The response socket
    // only closes on actual client disconnect, which is what we want.
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) ctrl.abort();
    });

    // Tell Fastify we're taking over the response stream. Without this,
    // Fastify v5 tries to manage the response lifecycle in parallel with
    // our reply.raw.writeHead + stream.pipe, which races and drops the
    // connection before any SSE bytes leave the socket.
    reply.hijack();

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    });

    const stream = runClaude(
      { ...(body as RunRequest), messages: runMessages },
      ctrl.signal,
      { spawn: opts.spawn },
    );
    stream.pipe(reply.raw);
    // No `return reply` — after hijack, Fastify ignores the handler's
    // return value.
    return;
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
