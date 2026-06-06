import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { mintBridgeToken } from '../src/bridgeToken.js';

describe('mintBridgeToken', () => {
	it('브릿지 HMAC 형식 <issuedAtMs>.<hex> 으로 발급한다', () => {
		const t = mintBridgeToken('secret', 1000);
		expect(t).toBe(`1000.${createHmac('sha256', 'secret').update('1000').digest('hex')}`);
		expect(t).toMatch(/^\d+\.[0-9a-f]{64}$/);
	});
});
