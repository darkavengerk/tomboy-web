import { describe, it, expect } from 'vitest';
import { resolveSource } from '../src/validate.js';

describe('resolveSource', () => {
	it('http(s) URL은 url', () => {
		expect(resolveSource('https://www.youtube.com/watch?v=abc')).toEqual({ kind: 'url', value: 'https://www.youtube.com/watch?v=abc' });
	});
	it('일반 텍스트는 ytsearch1', () => {
		expect(resolveSource('Artist - Title')).toEqual({ kind: 'search', value: 'ytsearch1:Artist - Title' });
	});
	it('빈/대시시작/file:은 reject', () => {
		expect(resolveSource('').kind).toBe('reject');
		expect(resolveSource('   ').kind).toBe('reject');
		expect(resolveSource('-x --rm').kind).toBe('reject');
		expect(resolveSource('file:///etc/passwd').kind).toBe('reject');
	});
});
