import { describe, it, expect } from 'vitest';
import { formatClaudeError } from '$lib/chatNote/formatClaudeError.js';
import { ClaudeChatError } from '$lib/chatNote/backends/claude.js';

describe('formatClaudeError', () => {
	it('image_fetch_failed + too-large detail → MB 단위 인간화 문구', () => {
		const err = new ClaudeChatError(
			'image_fetch_failed',
			'image fetch failed (https://x/temp-images/a.png): image too large: 21165980 bytes > 8388608'
		);
		const line = formatClaudeError(err);
		expect(line).toContain('이미지가 너무 큼');
		expect(line).toContain('20.2MB');
		expect(line).toContain('8.0MB');
	});

	it('image_fetch_failed + 기타 detail → 가져오기 실패 + detail 노출', () => {
		const err = new ClaudeChatError(
			'image_fetch_failed',
			'image fetch failed (https://x/temp-images/a.png): HTTP 404'
		);
		const line = formatClaudeError(err);
		expect(line).toContain('이미지 가져오기 실패');
		expect(line).toContain('HTTP 404');
	});

	it('네트워크 계열은 기존 연결 실패 문구 유지', () => {
		for (const kind of ['network', 'upstream_error', 'stream_error'] as const) {
			expect(formatClaudeError(new ClaudeChatError(kind))).toBe('[오류: 연결 실패. 재시도?]');
		}
	});

	it('기존 kind 문구 회귀 없음', () => {
		expect(formatClaudeError(new ClaudeChatError('unauthorized'))).toContain('인증 실패');
		expect(formatClaudeError(new ClaudeChatError('rate_limited'))).toContain('한도');
		expect(formatClaudeError(new ClaudeChatError('payload_too_large'))).toContain('노트가 너무 큼');
		expect(formatClaudeError(new ClaudeChatError('cli_failed', 'boom'))).toContain('boom');
	});
});
