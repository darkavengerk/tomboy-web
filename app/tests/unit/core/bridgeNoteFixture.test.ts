import { describe, it, expect } from 'vitest';
import { deserializeContent, serializeContent } from '../../../src/lib/core/noteContentArchiver';

// bridge/src/noteMarkdown.test.ts의 XML fixture와 동일 문자열 (수동 동기화 — 변경 시 양쪽 갱신)
const BRIDGE_XML = `<note-content version="0.1">[tomboy-web/shifu] 작업

<bold>범위</bold>
<list><list-item dir="ltr">하는 것: 브릿지 노트 API
<list><list-item dir="ltr">세부: <link:internal>[tomboy-web] 로그</link:internal>
</list-item></list>
</list-item><list-item dir="ltr">안 하는 것: rename</list-item></list>

<bold>상태  (HEAD: abc1234)</bold>
[x] 직렬화기
[ ] 배포

다음 명령: <monospace>npm test</monospace></note-content>`;

describe('bridge 노트 fixture ↔ 앱 archiver', () => {
	it('deserialize → serialize 바이트 동일 (브릿지 산출물이 앱 규약과 일치)', () => {
		const doc = deserializeContent(BRIDGE_XML);
		expect(serializeContent(doc)).toBe(BRIDGE_XML);
	});

	it('[x] / [ ]가 inlineCheckbox atom으로 파싱됨', () => {
		const doc = deserializeContent(BRIDGE_XML);
		const json = JSON.stringify(doc);
		expect(json).toContain('inlineCheckbox');
	});

	it('link:internal이 내부링크 마크로 파싱됨 (제목에 대괄호 포함)', () => {
		const json = JSON.stringify(deserializeContent(BRIDGE_XML));
		expect(json).toContain('[tomboy-web] 로그');
		expect(json).toContain('tomboyInternalLink');
	});
});
