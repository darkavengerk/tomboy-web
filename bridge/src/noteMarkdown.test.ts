import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdToNoteContent, noteContentToMd, escapeXml } from './noteMarkdown.js';

const MD = `## 범위
- 하는 것: 브릿지 노트 API
  - 세부: [[[tomboy-web] 로그]]
- 안 하는 것: rename

## 상태  (HEAD: abc1234)
[x] 직렬화기
[ ] 배포

다음 명령: \`npm test\``;

const XML = `<note-content version="0.1">[tomboy-web/shifu] 작업

<bold>범위</bold>
<list><list-item dir="ltr">하는 것: 브릿지 노트 API
<list><list-item dir="ltr">세부: <link:internal>[tomboy-web] 로그</link:internal>
</list-item></list>
</list-item><list-item dir="ltr">안 하는 것: rename</list-item></list>

<bold>상태  (HEAD: abc1234)</bold>
[x] 직렬화기
[ ] 배포

다음 명령: <monospace>npm test</monospace></note-content>`;

test('mdToNoteContent: 표준 작업노트 형태', () => {
  assert.equal(mdToNoteContent('[tomboy-web/shifu] 작업', MD), XML);
});

test('noteContentToMd: 역변환', () => {
  const { title, markdown } = noteContentToMd(XML);
  assert.equal(title, '[tomboy-web/shifu] 작업');
  assert.equal(markdown, MD);
});

test('이스케이프 왕복: & < >', () => {
  const xml = mdToNoteContent('[p/b] 작업', 'a < b && c > d');
  assert.ok(xml.includes('a &lt; b &amp;&amp; c &gt; d'));
  assert.equal(noteContentToMd(xml).markdown, 'a < b && c > d');
});

test('펜스 → 줄별 monospace (역변환은 인라인 코드로 축퇴)', () => {
  const xml = mdToNoteContent('[p/b] 작업', '```\nnpm run dev\ngit status\n```');
  assert.ok(xml.includes('<monospace>npm run dev</monospace>\n<monospace>git status</monospace>'));
  assert.equal(noteContentToMd(xml).markdown, '`npm run dev`\n`git status`');
});

test('--- 단독 줄은 드롭 (hrSplit 트리거 회피)', () => {
  const xml = mdToNoteContent('[p/b] 작업', 'a\n---\nb');
  assert.ok(!xml.includes('---'));
});

test('escapeXml 3종만', () => {
  assert.equal(escapeXml(`&<>"'`), `&amp;&lt;&gt;"'`);
});

test('헤딩 내부 링크: bold가 link를 감싸도록 합성 (## 다음: [[어떤 노트]])', () => {
  const md = '## 다음: [[어떤 노트]]';
  const xml = mdToNoteContent('[tomboy-web/shifu] 작업', md);
  assert.equal(
    xml,
    `<note-content version="0.1">[tomboy-web/shifu] 작업\n\n<bold>다음: <link:internal>어떤 노트</link:internal></bold></note-content>`
  );
  assert.equal(noteContentToMd(xml).markdown, md);
});

test('단락 내 볼드 런이 링크를 감싸면 하나의 **...**로 병합 (앞 **굵게 [[링크]] 뒤** 끝)', () => {
  const md = '앞 **굵게 [[링크]] 뒤** 끝';
  const xml = mdToNoteContent('[tomboy-web/shifu] 작업', md);
  assert.ok(xml.includes('앞 <bold>굵게 <link:internal>링크</link:internal> 뒤</bold> 끝'));
  assert.equal(noteContentToMd(xml).markdown, md);
});

test('여러 볼드 런이 줄 처음/끝을 감싸도 거짓 헤딩 승격 없음 (중요** 오늘 처리 **긴급 오인 방지)', () => {
  const xml = `<note-content version="0.1">[p/b] 작업\n\n<bold>중요</bold> 오늘 처리 <bold>긴급</bold></note-content>`;
  const { markdown } = noteContentToMd(xml);
  assert.equal(markdown, '**중요** 오늘 처리 **긴급**');
  assert.equal(mdToNoteContent('[p/b] 작업', markdown), xml);
});

test('리스트 깊이 점프(4칸 들여쓰기)는 clamp되어 항목 유실 없음 — b는 a의 자식으로 생존', () => {
  const xml = mdToNoteContent('[p/b] 작업', '- a\n    - b\n- c');
  assert.equal(
    xml,
    `<note-content version="0.1">[p/b] 작업\n\n<list><list-item dir="ltr">a\n<list><list-item dir="ltr">b\n</list-item></list>\n</list-item><list-item dir="ltr">c</list-item></list></note-content>`
  );
  assert.equal(noteContentToMd(xml).markdown, '- a\n  - b\n- c');
});

test('첫 항목이 들여쓰기로 시작해도 depth 0으로 clamp (빈 <list></list> 방지)', () => {
  const xml = mdToNoteContent('[p/b] 작업', '  - only');
  assert.equal(
    xml,
    `<note-content version="0.1">[p/b] 작업\n\n<list><list-item dir="ltr">only</list-item></list></note-content>`
  );
});

test('코드 스팬은 인코딩 시 불투명 — 안의 **/[[]]가 마크로 오인되지 않음', () => {
  const md = '코드 `f(**a, **b)` 와 `[[링크아님]]` 끝';
  const xml = mdToNoteContent('[p/b] 작업', md);
  assert.ok(xml.includes('<monospace>f(**a, **b)</monospace>'));
  assert.ok(xml.includes('<monospace>[[링크아님]]</monospace>'));
  assert.ok(!xml.includes('<bold>'));
  assert.ok(!xml.includes('<link:internal>'));
  assert.equal(noteContentToMd(xml).markdown, md);
});

test('연속 동일 들여쓰기(4칸) 형제는 체인이 아니라 SIBLINGS — indent-stack 회귀', () => {
  const xml = mdToNoteContent('[p/b] 작업', '- a\n    - b\n    - c\n    - d');
  assert.equal(
    xml,
    `<note-content version="0.1">[p/b] 작업\n\n<list><list-item dir="ltr">a\n<list><list-item dir="ltr">b\n</list-item><list-item dir="ltr">c\n</list-item><list-item dir="ltr">d\n</list-item></list></list-item></list></note-content>`
  );
  // 중첩 <list>는 하나뿐(그 안에 b/c/d 세 <list-item>) — 체인이면 <list>가 4개(a>b>c>d) 나왔을 것
  assert.equal((xml.match(/<list>/g) ?? []).length, 2);
  assert.equal((xml.match(/<list-item /g) ?? []).length, 4);
  assert.equal(noteContentToMd(xml).markdown, '- a\n  - b\n  - c\n  - d');
});

test('워크로그 실사례: 완료/남음 아래 각각 형제 자식 (파싱·테스트 / 배포) — 체인 오염 없음', () => {
  const md = '## 상태\n- 완료\n    - 파싱\n    - 테스트\n- 남음\n    - 배포';
  const xml = mdToNoteContent('[p/b] 작업', md);
  assert.equal(
    xml,
    `<note-content version="0.1">[p/b] 작업\n\n<bold>상태</bold>\n<list><list-item dir="ltr">완료\n<list><list-item dir="ltr">파싱\n</list-item><list-item dir="ltr">테스트\n</list-item></list>\n</list-item><list-item dir="ltr">남음\n<list><list-item dir="ltr">배포\n</list-item></list></list-item></list></note-content>`
  );
  assert.equal(noteContentToMd(xml).markdown, '## 상태\n- 완료\n  - 파싱\n  - 테스트\n- 남음\n  - 배포');
});

test('indent-stack 치환 후에도 기존 clamp 결과 불변 — 4칸 자식(depth1)/dedent(depth0)/첫줄 들여쓰기(depth0)', () => {
  const xmlNested = mdToNoteContent('[p/b] 작업', '- a\n    - b\n- c');
  assert.equal(
    xmlNested,
    `<note-content version="0.1">[p/b] 작업\n\n<list><list-item dir="ltr">a\n<list><list-item dir="ltr">b\n</list-item></list>\n</list-item><list-item dir="ltr">c</list-item></list></note-content>`
  );
  assert.equal(noteContentToMd(xmlNested).markdown, '- a\n  - b\n- c');

  const xmlFirstIndented = mdToNoteContent('[p/b] 작업', '  - only');
  assert.equal(
    xmlFirstIndented,
    `<note-content version="0.1">[p/b] 작업\n\n<list><list-item dir="ltr">only</list-item></list></note-content>`
  );
});

test('혼합 dedent(4칸→2칸)는 4-레벨을 pop 후 새 레벨을 열어 b/c가 a의 형제 자식 — 왕복 안정', () => {
  const xml = mdToNoteContent('[p/b] 작업', '- a\n    - b\n  - c');
  assert.equal(
    xml,
    `<note-content version="0.1">[p/b] 작업\n\n<list><list-item dir="ltr">a\n<list><list-item dir="ltr">b\n</list-item><list-item dir="ltr">c\n</list-item></list></list-item></list></note-content>`
  );
  assert.equal(noteContentToMd(xml).markdown, '- a\n  - b\n  - c');
});
