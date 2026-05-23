import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { makeFakeSpawn } from './_fakes.js';

describe('claude-service POST /chat', () => {
  let app: ReturnType<typeof buildServer>;
  let fake: ReturnType<typeof makeFakeSpawn>;

  beforeEach(() => {
    fake = makeFakeSpawn();
    app = buildServer({ sharedToken: 'test-token', spawn: fake.spawn });
  });
  afterEach(async () => { await app.close(); });

  it('401 without Bearer', async () => {
    const r = await app.inject({ method: 'POST', url: '/chat', payload: { messages: [] } });
    expect(r.statusCode).toBe(401);
  });

  it('401 with wrong Bearer', async () => {
    const r = await app.inject({
      method: 'POST', url: '/chat',
      headers: { authorization: 'Bearer wrong' },
      payload: { messages: [] },
    });
    expect(r.statusCode).toBe(401);
  });

  it('400 when messages missing', async () => {
    const r = await app.inject({
      method: 'POST', url: '/chat',
      headers: { authorization: 'Bearer test-token' },
      payload: {},
    });
    expect(r.statusCode).toBe(400);
  });

  it('400 when messages is empty array', async () => {
    const r = await app.inject({
      method: 'POST', url: '/chat',
      headers: { authorization: 'Bearer test-token' },
      payload: { messages: [] },
    });
    expect(r.statusCode).toBe(400);
  });

  it('200 streams SSE for valid request', async () => {
    // Start request — fake spawn captures child.
    const inject = app.inject({
      method: 'POST', url: '/chat',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      },
    });
    // Wait until Fastify has dispatched the route handler and called spawn.
    // Multiple ticks are needed for async Fastify request parsing + handler.
    const deadline = Date.now() + 500;
    while (fake.lastCall === null && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r));
    }
    fake.lastCall!.child.emitStdout('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n');
    fake.lastCall!.child.emitStdout('{"type":"result","subtype":"success"}\n');
    fake.lastCall!.child.exit(0);

    const r = await inject;
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/event-stream/);
    expect(r.body).toContain('data: {"delta":"hi"}');
    expect(r.body).toContain('data: {"done":true');
  });

  it('413 when payload exceeds limit', async () => {
    const huge = 'x'.repeat(3 * 1024 * 1024);
    const r = await app.inject({
      method: 'POST', url: '/chat',
      headers: { authorization: 'Bearer test-token' },
      payload: { messages: [{ role: 'user', content: [{ type: 'text', text: huge }] }] },
    });
    expect(r.statusCode).toBe(413);
  });
});
