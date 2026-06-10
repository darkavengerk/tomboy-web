import { describe, it, expect } from 'vitest';
import { createEmptyNote, escapeXml, type NoteData } from '$lib/core/note.js';
import { buildPdfBundle, previewPdfBundle } from '$lib/remarkable/pdf/pdfBundle.js';
import type { PdfBlock } from '$lib/remarkable/pdf/tiptapToPdfmake.js';

function makeNote(guid: string, title: string, bodyXml = ''): NoteData {
	const note = createEmptyNote(guid);
	note.title = title;
	note.xmlContent = `<note-content version="0.1">${escapeXml(title)}\n\n${bodyXml}\n</note-content>`;
	return note;
}

function linkTo(target: string): string {
	return `<link:internal>${escapeXml(target)}</link:internal>`;
}

function findLinkInlines(blocks: Array<PdfBlock | string>): PdfBlock[] {
	const out: PdfBlock[] = [];
	for (const b of blocks) {
		if (typeof b !== 'object') continue;
		if (Array.isArray(b.text)) {
			for (const inline of b.text) {
				if (typeof inline === 'object' && inline.linkToDestination) out.push(inline);
			}
		}
		for (const arr of [b.ul, b.ol, b.stack]) {
			if (arr) out.push(...findLinkInlines(arr));
		}
	}
	return out;
}

function collectText(blocks: Array<PdfBlock | string>): string {
	const parts: string[] = [];
	for (const b of blocks) {
		if (typeof b === 'string') {
			parts.push(b);
			continue;
		}
		if (typeof b.text === 'string') parts.push(b.text);
		else if (Array.isArray(b.text)) {
			for (const inline of b.text) {
				if (typeof inline === 'string') parts.push(inline);
				else if (typeof inline.text === 'string') parts.push(inline.text);
			}
		}
		for (const arr of [b.ul, b.ol, b.stack]) {
			if (arr) parts.push(collectText(arr));
		}
	}
	return parts.join(' ');
}

describe('buildPdfBundle', () => {
	it('returns empty docDefinition when root guid is missing', async () => {
		const out = await buildPdfBundle('missing', [], { depth: 1 });
		expect(out.includedGuids).toEqual([]);
		expect(out.docDefinition.content).toEqual([]);
	});

	it('depth 0 includes only the root note, no page break', async () => {
		const root = makeNote('g1', 'Root', `Body says ${linkTo('Other')}`);
		const other = makeNote('g2', 'Other', 'unrelated');
		const out = await buildPdfBundle('g1', [root, other], { depth: 0 });
		expect(out.includedGuids).toEqual(['g1']);
		const header = out.docDefinition.content[0] as PdfBlock;
		expect(header).toMatchObject({ text: 'Root', id: 'note-g1', style: 'noteTitle' });
		expect(header.pageBreak).toBeUndefined();
	});

	it('depth 1 follows direct links and separates each follower with top margin (no forced page-break)', async () => {
		const root = makeNote(
			'g1',
			'Root',
			`See ${linkTo('Other')} and ${linkTo('Third')}.`
		);
		const other = makeNote('g2', 'Other', 'second');
		const third = makeNote('g3', 'Third', 'third');
		const out = await buildPdfBundle('g1', [root, other, third], { depth: 1 });
		expect(out.includedGuids).toEqual(['g1', 'g2', 'g3']);
		const headers = out.docDefinition.content.filter(
			(b): b is PdfBlock => typeof b === 'object' && b.style === 'noteTitle'
		);
		expect(headers).toHaveLength(3);
		// 노트 사이 강제 페이지 분리 없음 — 짧은 노트는 같은 페이지에 흐른다.
		expect(headers[0].pageBreak).toBeUndefined();
		expect(headers[1].pageBreak).toBeUndefined();
		expect(headers[2].pageBreak).toBeUndefined();
		// 단 두 번째부터는 헤더 위에 큰 margin 으로 시각적 경계.
		expect(headers[0].margin).toBeUndefined();
		expect(headers[1].margin?.[1]).toBeGreaterThan(0);
		expect(headers[2].margin?.[1]).toBeGreaterThan(0);
	});

	it('dedupes a note reached via multiple paths', async () => {
		const root = makeNote(
			'g1',
			'Root',
			`${linkTo('A')} and ${linkTo('B')}`
		);
		const a = makeNote('a', 'A', `also ${linkTo('B')}`);
		const b = makeNote('b', 'B', 'leaf');
		const out = await buildPdfBundle('g1', [root, a, b], { depth: 3 });
		expect(out.includedGuids).toEqual(['g1', 'a', 'b']);
		expect(out.includedGuids.filter((g) => g === 'b')).toHaveLength(1);
	});

	it('depth 2 reaches grandchildren but not depth-3 notes', async () => {
		const root = makeNote('g1', 'Root', linkTo('Child'));
		const child = makeNote('c', 'Child', linkTo('Grand'));
		const grand = makeNote('gc', 'Grand', linkTo('GreatGrand'));
		const great = makeNote('ggc', 'GreatGrand', 'leaf');
		const out = await buildPdfBundle('g1', [root, child, grand, great], { depth: 2 });
		expect(out.includedGuids).toEqual(['g1', 'c', 'gc']);
		expect(out.includedGuids).not.toContain('ggc');
	});

	it('drops links to notes whose title resolves to no guid', async () => {
		const root = makeNote('g1', 'Root', `${linkTo('NoSuchTitle')}`);
		const out = await buildPdfBundle('g1', [root], { depth: 2 });
		expect(out.includedGuids).toEqual(['g1']);
	});

	it('renders an internal link to an in-bundle note as linkToDestination', async () => {
		const root = makeNote('g1', 'Root', `see ${linkTo('Other')}`);
		const other = makeNote('g2', 'Other', 'body');
		const out = await buildPdfBundle('g1', [root, other], { depth: 1 });
		const linkInlines = findLinkInlines(out.docDefinition.content);
		expect(linkInlines).toHaveLength(1);
		expect(linkInlines[0]).toMatchObject({
			text: 'Other',
			linkToDestination: 'note-g2'
		});
	});

	it("an internal link to a note outside the bundle is rendered as plain text", async () => {
		// depth 0 — Other isn't included, so the link mark drops to plain text.
		const root = makeNote('g1', 'Root', `see ${linkTo('Other')}`);
		const other = makeNote('g2', 'Other', 'body');
		const out = await buildPdfBundle('g1', [root, other], { depth: 0 });
		expect(findLinkInlines(out.docDefinition.content)).toHaveLength(0);
	});

	it('strips body first paragraph when it equals the note title', async () => {
		// Tomboy 컨벤션: <note-content> 의 첫 줄이 title 과 같다. PDF 헤더가 별도로
		// 들어가므로 본문에서는 그 paragraph 를 제거해야 중복이 안 난다. 빈
		// paragraph(`\n\n` 구분자)와 trailing 빈 paragraph 는 사용자 의도 공백일
		// 수 있어 v1 에서는 유지한다 — 검증은 "Root" 텍스트가 어디에도 안 보임 +
		// "paragraph two" 가 들어 있음.
		const root = makeNote('g1', 'Root', 'paragraph two');
		const out = await buildPdfBundle('g1', [root], { depth: 0 });
		const bodyBlocks = out.docDefinition.content.slice(1);
		expect(collectText(bodyBlocks)).not.toContain('Root');
		expect(collectText(bodyBlocks)).toContain('paragraph two');
	});

	it('keeps body first paragraph when it differs from the title', async () => {
		// title 과 본문 첫 줄이 다른 경우 (이론적으로 가능, 예: 사용자가 raw XML
		// 편집). 본문 첫 줄이 그대로 보존되어야 한다.
		const note = createEmptyNote('g1');
		note.title = 'Different';
		note.xmlContent = `<note-content version="0.1">opening line\n\nrest\n</note-content>`;
		const out = await buildPdfBundle('g1', [note], { depth: 0 });
		const bodyText = collectText(out.docDefinition.content.slice(1));
		expect(bodyText).toContain('opening line');
		expect(bodyText).toContain('rest');
	});

	it('docDefinition info.title = root title, defaultStyle has Korean font', async () => {
		const root = makeNote('g1', '루트', 'body');
		const out = await buildPdfBundle('g1', [root], { depth: 0 });
		expect(out.docDefinition.info?.title).toBe('루트');
		expect(out.docDefinition.defaultStyle?.font).toBe('Korean');
		expect(out.docDefinition.styles?.noteTitle).toBeDefined();
	});

	describe('excludedGuids', () => {
		it('removes the excluded note from the bundle entirely', async () => {
			const root = makeNote('g1', 'Root', `${linkTo('A')} and ${linkTo('B')}`);
			const a = makeNote('a', 'A', 'note a');
			const b = makeNote('b', 'B', 'note b');
			const out = await buildPdfBundle('g1', [root, a, b], {
				depth: 1,
				excludedGuids: new Set(['b'])
			});
			expect(out.includedGuids).toEqual(['g1', 'a']);
			expect(out.includedGuids).not.toContain('b');
		});

		it('removes notes only reachable through an excluded note', async () => {
			// Root → A → C  (C reachable only via A)
			const root = makeNote('g1', 'Root', linkTo('A'));
			const a = makeNote('a', 'A', linkTo('C'));
			const c = makeNote('c', 'C', 'leaf');
			const out = await buildPdfBundle('g1', [root, a, c], {
				depth: 2,
				excludedGuids: new Set(['a'])
			});
			expect(out.includedGuids).toEqual(['g1']);
		});

		it('a link to an excluded note becomes plain text', async () => {
			const root = makeNote('g1', 'Root', `see ${linkTo('Other')}`);
			const other = makeNote('g2', 'Other', 'body');
			const out = await buildPdfBundle('g1', [root, other], {
				depth: 1,
				excludedGuids: new Set(['g2'])
			});
			expect(findLinkInlines(out.docDefinition.content)).toHaveLength(0);
			expect(collectText(out.docDefinition.content)).toContain('Other');
		});
	});
});

describe('previewPdfBundle', () => {
	it('returns a tree rooted at rootGuid', () => {
		const root = makeNote('g1', 'Root', `${linkTo('A')} and ${linkTo('B')}`);
		const a = makeNote('a', 'A', 'note a');
		const b = makeNote('b', 'B', linkTo('A'));
		const out = previewPdfBundle('g1', [root, a, b], { depth: 2 });
		expect(out.tree).not.toBeNull();
		expect(out.tree!.guid).toBe('g1');
		expect(out.includedGuids).toEqual(['g1', 'a', 'b']);
		const childGuids = out.tree!.children.map((c: { guid: string }) => c.guid);
		expect(childGuids).toEqual(['a', 'b']);
	});

	it('shows the same guid under multiple parents when reached via multiple paths', () => {
		// Root → A → C
		// Root → B → C
		const root = makeNote('g1', 'Root', `${linkTo('A')} and ${linkTo('B')}`);
		const a = makeNote('a', 'A', linkTo('C'));
		const b = makeNote('b', 'B', linkTo('C'));
		const c = makeNote('c', 'C', 'leaf');
		const out = previewPdfBundle('g1', [root, a, b, c], { depth: 2 });
		const aNode = out.tree!.children.find((n: { guid: string }) => n.guid === 'a');
		const bNode = out.tree!.children.find((n: { guid: string }) => n.guid === 'b');
		// C appears under BOTH A and B.
		expect(aNode!.children.map((n: { guid: string }) => n.guid)).toEqual(['c']);
		expect(bNode!.children.map((n: { guid: string }) => n.guid)).toEqual(['c']);
	});

	it('excluded guid disappears from the tree', () => {
		const root = makeNote('g1', 'Root', `${linkTo('A')} and ${linkTo('B')}`);
		const a = makeNote('a', 'A', 'note a');
		const b = makeNote('b', 'B', 'note b');
		const out = previewPdfBundle('g1', [root, a, b], {
			depth: 1,
			excludedGuids: new Set(['a'])
		});
		expect(out.tree!.children.map((c: { guid: string }) => c.guid)).toEqual(['b']);
		expect(out.includedGuids).toEqual(['g1', 'b']);
	});
});
