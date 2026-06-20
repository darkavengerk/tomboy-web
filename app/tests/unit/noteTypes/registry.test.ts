import { describe, it, expect } from 'vitest';
import {
	NOTE_TYPES,
	getNoteType,
	composeTitle,
	bodyFirstLine
} from '$lib/noteTypes/registry.js';

describe('noteTypes registry', () => {
	it('plain 포함 16종을 노출한다', () => {
		expect(NOTE_TYPES.length).toBe(16);
		expect(NOTE_TYPES[0].id).toBe('plain');
		expect(getNoteType('terminal')?.label).toContain('터미널');
	});

	it('title-prefix 타입은 접두어를 붙인다', () => {
		expect(composeTitle('automation', '매출')).toBe('자동화::매출');
		expect(composeTitle('data', '매출')).toBe('DATA::매출');
		expect(composeTitle('music-extract', 'p')).toBe('음악추출::p');
	});

	it('body-signature/plain 타입은 타이틀을 그대로 둔다', () => {
		expect(composeTitle('terminal', '서버')).toBe('서버');
		expect(composeTitle('plain', '메모')).toBe('메모');
	});

	it('body-signature 타입만 본문 시그니처 줄을 준다', () => {
		expect(bodyFirstLine('terminal')).toBe('ssh://user@host');
		expect(bodyFirstLine('chat-ollama')).toBe('llm://qwen2.5-coder:3b');
		expect(bodyFirstLine('automation')).toBeUndefined();
		expect(bodyFirstLine('plain')).toBeUndefined();
	});

	it('알 수 없는 id 는 undefined', () => {
		expect(getNoteType('nope')).toBeUndefined();
		expect(composeTitle('nope', 'x')).toBe('x');
		expect(bodyFirstLine('nope')).toBeUndefined();
	});
});
