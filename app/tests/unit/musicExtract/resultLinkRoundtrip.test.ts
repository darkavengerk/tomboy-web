import { describe, it, expect } from 'vitest';
import { serializeContent, deserializeContent } from '$lib/core/noteContentArchiver.js';

const UUID = 'ab12cd34-5678-49ab-8cde-0123456789ab';
const URL = `https://b.ex/files/${UUID}/Song.mp3`;

// writeExtractResult 가 만드는 형태: 소스 항목 + 자식 결과(텍스트==href==URL 인 tomboyUrlLink)
const doc = {
	type: 'doc',
	content: [
		{ type: 'paragraph', content: [{ type: 'text', text: '음악추출::x' }] },
		{ type: 'bulletList', content: [
			{ type: 'listItem', content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'https://yt/aaa' }] },
				{ type: 'bulletList', content: [
					{ type: 'listItem', content: [
						{ type: 'paragraph', content: [
							{ type: 'text', text: URL, marks: [{ type: 'tomboyUrlLink', attrs: { href: URL } }] }
						] }
					] }
				] }
			] }
		] }
	]
};

describe('결과 링크 .note 라운드트립', () => {
	it('/files URL이 직렬화→역직렬화 후에도 텍스트·href에 보존된다', () => {
		const restored = deserializeContent(serializeContent(doc));
		const json = JSON.stringify(restored);
		// 텍스트가 URL이라 round-trip에서 살아남는다. (title을 텍스트로 두면 여기서 깨졌을 것)
		expect(json).toContain(`/files/${UUID}/Song.mp3`);
		// 복원된 tomboyUrlLink href 도 동일 URL (textContent로부터 복원)
		const findHref = (n: any): string | null => {
			if (n?.marks) { const m = n.marks.find((x: any) => x.type === 'tomboyUrlLink'); if (m) return m.attrs?.href ?? null; }
			if (Array.isArray(n?.content)) { for (const c of n.content) { const r = findHref(c); if (r) return r; } }
			return null;
		};
		expect(findHref(restored)).toContain(`/files/${UUID}/`);
	});
});
