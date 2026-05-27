import { describe, it, expect } from 'vitest';
import { requireBearer } from '../../../src/routes/api/temp-image/_lib/auth.js';

function reqWith(header: string | undefined): Request {
  return new Request('http://example.com/', {
    headers: header ? { Authorization: header } : {}
  });
}

describe('requireBearer', () => {
  it('throws 401 when Authorization header missing', () => {
    expect(() => requireBearer(reqWith(undefined), 'secret')).toThrow(/401/);
  });

  it('throws 401 on wrong scheme', () => {
    expect(() => requireBearer(reqWith('Basic abc'), 'secret')).toThrow(/401/);
  });

  it('throws 401 on wrong token', () => {
    expect(() => requireBearer(reqWith('Bearer wrong'), 'secret')).toThrow(/401/);
  });

  it('returns void on matching token', () => {
    expect(() => requireBearer(reqWith('Bearer secret'), 'secret')).not.toThrow();
  });

  it('throws 500 when env token missing', () => {
    expect(() => requireBearer(reqWith('Bearer x'), '')).toThrow(/500/);
  });
});
