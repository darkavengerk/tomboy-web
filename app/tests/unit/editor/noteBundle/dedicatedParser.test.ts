import { describe, it, expect } from 'vitest';
import {
	dedicatedBundleKind,
	parseDedicatedBundle,
	buildSyntheticBundleSpec,
	type BundleNode,
	type BundleEntry
} from '$lib/editor/noteBundle/parser.js';

// --- JSON 빌더(에디터 불필요 — 전용 파서는 JSONContent 를 직접 소비) -------
const doc = (...blocks: object[]) => ({ type: 'doc', content: blocks });
const title = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
const txt = (t: string) => ({ type: 'text', text: t });
const link = (t: string) => ({
	type: 'text',
	text: t,
	marks: [{ type: 'tomboyInternalLink', attrs: { target: t } }]
});
const para = (...nodes: object[]) => ({ type: 'paragraph', content: nodes });
const li = (...content: object[]) => ({ type: 'listItem', content });
const ul = (...items: object[]) => ({ type: 'bulletList', content: items });
/** 단락 하나짜리 리스트 항목 */
const pli = (...nodes: object[]) => li(para(...nodes));

describe('dedicatedBundleKind — 제목 시그니처', () => {
	it('탭:: / 묶음:: 접두', () => {
		expect(dedicatedBundleKind('탭::메뉴')).toBe('tab');
		expect(dedicatedBundleKind('묶음::할 일')).toBe('bundle');
	});
	it('선행 공백 허용', () => {
		expect(dedicatedBundleKind('  탭::x')).toBe('tab');
	});
	it('단일 콜론 / 무관 제목 → null', () => {
		expect(dedicatedBundleKind('탭:x')).toBeNull();
		expect(dedicatedBundleKind('탭')).toBeNull();
		expect(dedicatedBundleKind('메모')).toBeNull();
		expect(dedicatedBundleKind('')).toBeNull();
	});
});

describe('parseDedicatedBundle — bundle(평면 엔트리)', () => {
	it('본문 단락 링크 = 깊이1, 단락+직후 리스트 = 깊이2 카테고리', () => {
		const d = doc(
			title('묶음::메뉴'),
			para(link('A')),
			para(txt('프로젝트')),
			ul(pli(link('B')), li(para(link('C')), ul(pli(link('D')))))
		);
		const spec = parseDedicatedBundle(d, 'bundle');
		expect(spec.kind).toBe('bundle');
		expect(spec.tree).toEqual([]);
		const entries: BundleEntry[] = spec.entries;
		// C 는 자식 D 가 있으므로 순수 카테고리 — C 자신은 엔트리에서 빠지고 D 의 category 로만.
		expect(entries).toEqual([
			{ title: 'A', category: null, srcTop: 1 },
			{ title: 'B', category: '프로젝트', srcTop: 2 },
			{ title: 'D', category: 'C', srcTop: 2 }
		]);
	});
	it('제목 라인(블록 0)의 링크는 제외', () => {
		const d = doc(
			{ type: 'paragraph', content: [link('탭제목링크')] }, // 블록0 = 제목, 스킵
			para(link('A'))
		);
		const spec = parseDedicatedBundle(d, 'bundle');
		expect(spec.entries).toEqual([{ title: 'A', category: null, srcTop: 1 }]);
	});
	it('부모 단락 없는 리스트 → 카테고리 null', () => {
		const d = doc(title('묶음::x'), ul(pli(link('X')), pli(link('Y'))));
		const spec = parseDedicatedBundle(d, 'bundle');
		expect(spec.entries).toEqual([
			{ title: 'X', category: null, srcTop: 1 },
			{ title: 'Y', category: null, srcTop: 1 }
		]);
	});
	it('한 단락 안의 여러 링크 모두 수집', () => {
		const d = doc(title('묶음::x'), para(link('A'), txt(', '), link('B')));
		const spec = parseDedicatedBundle(d, 'bundle');
		expect(spec.entries).toEqual([
			{ title: 'A', category: null, srcTop: 1 },
			{ title: 'B', category: null, srcTop: 1 }
		]);
	});
});

describe('parseDedicatedBundle — tab(재귀 트리)', () => {
	it('단락=깊이1 잎, 단락+직후 리스트=깊이2 카테고리, 중첩=깊이3', () => {
		const d = doc(
			title('탭::메뉴'),
			para(link('A')),
			para(txt('프로젝트')),
			ul(pli(link('B')), li(para(link('C')), ul(pli(link('D')))))
		);
		const spec = parseDedicatedBundle(d, 'tab');
		expect(spec.kind).toBe('tab');
		expect(spec.entries).toEqual([]);
		const tree: BundleNode[] = spec.tree;
		// C 는 자식 D 가 있으므로 순수 카테고리 — 자기 링크 C 는 탭으로 추가되지 않는다.
		expect(tree).toEqual([
			{ label: 'A', link: 'A', children: [] },
			{
				label: '프로젝트',
				link: null,
				children: [
					{ label: 'B', link: 'B', children: [] },
					{
						label: 'C',
						link: null,
						children: [{ label: 'D', link: 'D', children: [] }]
					}
				]
			}
		]);
	});
	it('부모 단락 없는 리스트 → 항목이 깊이1로 직접', () => {
		const d = doc(title('탭::x'), ul(pli(link('X')), pli(link('Y'))));
		const spec = parseDedicatedBundle(d, 'tab');
		expect(spec.tree).toEqual([
			{ label: 'X', link: 'X', children: [] },
			{ label: 'Y', link: 'Y', children: [] }
		]);
	});
	it('링크 없는 단락(다음 리스트 없음)은 잎 생성 안 함', () => {
		const d = doc(title('탭::x'), para(txt('그냥 메모')), para(link('A')));
		const spec = parseDedicatedBundle(d, 'tab');
		expect(spec.tree).toEqual([{ label: 'A', link: 'A', children: [] }]);
	});
});

describe('parseDedicatedBundle — 옵션 라인(본문 2번째 줄 `:높이:개수`)', () => {
	it(':50:10 → heightPct 50 + maxCount 10, 옵션 라인은 엔트리에서 제외', () => {
		const d = doc(title('묶음::메뉴'), para(txt(':50:10')), para(link('A')), para(link('B')));
		const spec = parseDedicatedBundle(d, 'bundle');
		expect(spec.heightPct).toBe(50);
		expect(spec.maxCount).toBe(10);
		expect(spec.entries).toEqual([
			{ title: 'A', category: null, srcTop: 2 },
			{ title: 'B', category: null, srcTop: 3 }
		]);
	});
	it('::10 → 높이 생략은 기본 100 유지, 개수만 10', () => {
		const d = doc(title('묶음::x'), para(txt('::10')), para(link('A')));
		const spec = parseDedicatedBundle(d, 'bundle');
		expect(spec.heightPct).toBe(100);
		expect(spec.maxCount).toBe(10);
		expect(spec.entries).toEqual([{ title: 'A', category: null, srcTop: 2 }]);
	});
	it(':50 → 높이만, 개수 기본 5', () => {
		const d = doc(title('묶음::x'), para(txt(':50')), para(link('A')));
		const spec = parseDedicatedBundle(d, 'bundle');
		expect(spec.heightPct).toBe(50);
		expect(spec.maxCount).toBe(5);
	});
	it(':0 → 타이틀만(heightPct 0)', () => {
		const d = doc(title('묶음::x'), para(txt(':0')), para(link('A')));
		const spec = parseDedicatedBundle(d, 'bundle');
		expect(spec.heightPct).toBe(0);
	});
	it('개수 클램프 — :50:999 → 100', () => {
		const d = doc(title('묶음::x'), para(txt(':50:999')), para(link('A')));
		const spec = parseDedicatedBundle(d, 'bundle');
		expect(spec.maxCount).toBe(100);
	});
	it('옵션 라인 없으면 기본(100/5) + 2번째 줄 링크는 정상 엔트리', () => {
		const d = doc(title('묶음::x'), para(link('A')), para(link('B')));
		const spec = parseDedicatedBundle(d, 'bundle');
		expect(spec.heightPct).toBe(100);
		expect(spec.maxCount).toBe(5);
		expect(spec.entries).toEqual([
			{ title: 'A', category: null, srcTop: 1 },
			{ title: 'B', category: null, srcTop: 2 }
		]);
	});
	it('콜론만(:)·일반 텍스트는 옵션으로 소비하지 않음', () => {
		const d = doc(title('묶음::x'), para(txt(':')), para(link('A')));
		const spec = parseDedicatedBundle(d, 'bundle');
		expect(spec.maxCount).toBe(5);
		expect(spec.entries).toEqual([{ title: 'A', category: null, srcTop: 2 }]);
	});
	it('tab 종류도 옵션 라인 제외하고 트리 파싱', () => {
		const d = doc(title('탭::x'), para(txt(':50:10')), para(link('A')));
		const spec = parseDedicatedBundle(d, 'tab');
		expect(spec.maxCount).toBe(10);
		expect(spec.tree).toEqual([{ label: 'A', link: 'A', children: [] }]);
	});
	it('tab 옵션 없으면 기본 개수 3(묶음 5 와 다름)', () => {
		const d = doc(title('탭::x'), para(link('A')));
		expect(parseDedicatedBundle(d, 'tab').maxCount).toBe(3);
		const d2 = doc(title('묶음::x'), para(link('A')));
		expect(parseDedicatedBundle(d2, 'bundle').maxCount).toBe(5);
	});
});

describe('parseDedicatedBundle — 합성 spec 메타', () => {
	it('checked=true, heightPct=100, 쓰기백 위치는 의미없는 -1/null', () => {
		const spec = parseDedicatedBundle(doc(title('탭::x')), 'tab');
		expect(spec.checked).toBe(true);
		expect(spec.heightPct).toBe(100);
		expect(spec.ordinal).toBe(0);
		expect(spec.checkboxPos).toBe(-1);
		expect(spec.listPos).toBeNull();
		expect(spec.listEnd).toBeNull();
	});
});

describe('buildSyntheticBundleSpec — 역참조 등 합성 목록', () => {
	it('bundle: 제목 리스트 → 평면 엔트리(category 없음) + 합성 메타', () => {
		const spec = buildSyntheticBundleSpec(['가', '나', '다'], 'bundle');
		expect(spec.kind).toBe('bundle');
		expect(spec.entries).toEqual([
			{ title: '가', category: null, srcTop: -1 },
			{ title: '나', category: null, srcTop: -1 },
			{ title: '다', category: null, srcTop: -1 }
		]);
		expect(spec.tree).toEqual([]);
		expect(spec.checked).toBe(true);
		expect(spec.heightPct).toBe(100);
		expect(spec.checkboxPos).toBe(-1);
		expect(spec.listPos).toBeNull();
	});

	it('tab: 제목 리스트 → 평면 잎(link=label)', () => {
		const spec = buildSyntheticBundleSpec(['가', '나'], 'tab');
		expect(spec.kind).toBe('tab');
		expect(spec.tree).toEqual([
			{ label: '가', link: '가', children: [] },
			{ label: '나', link: '나', children: [] }
		]);
		expect(spec.entries).toEqual([]);
	});

	it('공백/빈 제목은 trim 후 제외', () => {
		const spec = buildSyntheticBundleSpec(['  가  ', '', '   ', '나'], 'bundle');
		expect(spec.entries).toEqual([
			{ title: '가', category: null, srcTop: -1 },
			{ title: '나', category: null, srcTop: -1 }
		]);
	});

	it('빈 목록 → 빈 spec', () => {
		const spec = buildSyntheticBundleSpec([], 'bundle');
		expect(spec.entries).toEqual([]);
		expect(spec.tree).toEqual([]);
	});
});
