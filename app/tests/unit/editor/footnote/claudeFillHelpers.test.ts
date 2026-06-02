import { describe, it, expect } from 'vitest';
import {
	extractTrigger,
	stripTriggerForRestore,
	buildFootnoteMessages,
	FOOTNOTE_SYSTEM_PROMPT
} from '$lib/editor/footnote/claudeFill.js';

describe('extractTrigger', () => {
	it('지시문 + @claude + 끝공백 → 지시문 추출', () => {
		expect(extractTrigger('좀 더 설명해줘 @claude ')).toEqual({
			instruction: '좀 더 설명해줘'
		});
	});
	it('지시문 없이 @claude + 공백도 성립', () => {
		expect(extractTrigger('@claude ')).toEqual({ instruction: '' });
	});
	it('뒤 공백 없으면 null', () => {
		expect(extractTrigger('설명 @claude')).toBeNull();
	});
	it('트리거 없는 일반 텍스트 → null', () => {
		expect(extractTrigger('보통 텍스트')).toBeNull();
	});
	it('@claude 뒤에 더 입력되어 끝이 아니면 null', () => {
		expect(extractTrigger('@claude 추가 입력 ')).toBeNull();
	});
	it('탭/개행도 트리거 공백으로 인정', () => {
		expect(extractTrigger('설명 @claude\t')).toEqual({ instruction: '설명' });
	});
});

describe('stripTriggerForRestore', () => {
	it('끝 공백만 제거해 재발화를 막는다', () => {
		expect(stripTriggerForRestore('설명해줘 @claude ')).toBe('설명해줘 @claude');
	});
	it('끝 공백이 없으면 그대로', () => {
		expect(stripTriggerForRestore('설명해줘 @claude')).toBe('설명해줘 @claude');
	});
});

describe('buildFootnoteMessages', () => {
	it('단일 user 메시지에 컨텍스트와 지시문을 담는다', () => {
		const msgs = buildFootnoteMessages('제목\n본문', '설명해줘');
		expect(msgs).toHaveLength(1);
		expect(msgs[0].role).toBe('user');
		expect(msgs[0].content).toHaveLength(1);
		const block = msgs[0].content[0];
		expect(block.type).toBe('text');
		const text = block.type === 'text' ? block.text : '';
		expect(text).toContain('제목\n본문');
		expect(text).toContain('설명해줘');
	});
});

describe('FOOTNOTE_SYSTEM_PROMPT', () => {
	it('각주·글자수·한국어 제약을 명시', () => {
		expect(FOOTNOTE_SYSTEM_PROMPT).toMatch(/각주/);
		expect(FOOTNOTE_SYSTEM_PROMPT).toMatch(/300/);
		expect(FOOTNOTE_SYSTEM_PROMPT).toMatch(/한국어/);
	});
});
