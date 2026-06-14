import { describe, it, expect } from 'vitest';
import {
	dedicatedBundleKind,
	parseDedicatedBundle,
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
		expect(entries).toEqual([
			{ title: 'A', category: null },
			{ title: 'B', category: '프로젝트' },
			{ title: 'C', category: '프로젝트' },
			{ title: 'D', category: 'C' }
		]);
	});
	it('제목 라인(블록 0)의 링크는 제외', () => {
		const d = doc(
			{ type: 'paragraph', content: [link('탭제목링크')] }, // 블록0 = 제목, 스킵
			para(link('A'))
		);
		const spec = parseDedicatedBundle(d, 'bundle');
		expect(spec.entries).toEqual([{ title: 'A', category: null }]);
	});
	it('부모 단락 없는 리스트 → 카테고리 null', () => {
		const d = doc(title('묶음::x'), ul(pli(link('X')), pli(link('Y'))));
		const spec = parseDedicatedBundle(d, 'bundle');
		expect(spec.entries).toEqual([
			{ title: 'X', category: null },
			{ title: 'Y', category: null }
		]);
	});
	it('한 단락 안의 여러 링크 모두 수집', () => {
		const d = doc(title('묶음::x'), para(link('A'), txt(', '), link('B')));
		const spec = parseDedicatedBundle(d, 'bundle');
		expect(spec.entries).toEqual([
			{ title: 'A', category: null },
			{ title: 'B', category: null }
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
						children: [
							{ label: 'C', link: 'C', children: [] },
							{ label: 'D', link: 'D', children: [] }
						]
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
