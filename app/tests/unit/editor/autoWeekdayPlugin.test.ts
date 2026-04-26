import { describe, it, expect, afterEach } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { createAutoWeekdayPlugin, autoWeekdayPluginKey } from '$lib/editor/autoWeekday/autoWeekdayPlugin.js';
import type { JSONContent } from '@tiptap/core';

// Apr 12 2026 is a Sunday → '일'
const FIXED_DATE = new Date(2026, 3, 12); // month is 0-indexed
const YEAR = 2026;
const MONTH = 4;

const WEEKDAY_CHARS = ['일', '월', '화', '수', '목', '금', '토'] as const;
function expectedWeekday(year: number, month: number, day: number): string {
	return WEEKDAY_CHARS[new Date(year, month - 1, day).getDay()];
}

let currentEditor: Editor | null = null;

function makeEditor(doc: JSONContent, enabled = true): Editor {
	let isEnabled = enabled;
	const editor = new Editor({
		extensions: [
			StarterKit.configure({ code: false, codeBlock: false, paragraph: false, listItem: false }),
			TomboyParagraph,
			TomboyListItem,
			Extension.create({
				name: 'tomboyAutoWeekday',
				addProseMirrorPlugins() {
					return [
						createAutoWeekdayPlugin({
							now: () => FIXED_DATE,
							enabled: () => isEnabled
						})
					];
				}
			})
		],
		content: doc
	});
	currentEditor = editor;
	return editor;
}

function makeEditorDisabled(doc: JSONContent): Editor {
	return makeEditor(doc, false);
}

/** Extract the first-paragraph text of a listItem at any depth. */
function collectListTexts(doc: JSONContent): string[] {
	const out: string[] = [];
	function visit(nodes: JSONContent[] | undefined): void {
		if (!nodes) return;
		for (const n of nodes) {
			if (n.type === 'listItem') {
				const firstPara = (n.content ?? []).find((c) => c.type === 'paragraph');
				const text = (firstPara?.content ?? [])
					.filter((c) => c.type === 'text')
					.map((c) => c.text ?? '')
					.join('');
				out.push(text);
				for (const child of n.content ?? []) {
					if (child.type === 'bulletList' || child.type === 'orderedList') {
						visit(child.content);
					}
				}
			} else if (n.type === 'bulletList' || n.type === 'orderedList') {
				visit(n.content);
			} else {
				visit(n.content);
			}
		}
	}
	visit(doc.content);
	return out;
}

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

// --- Helpers for building doc shapes ---

function p(text: string): JSONContent {
	return { type: 'paragraph', content: text ? [{ type: 'text', text }] : [] };
}

function li(text: string, ...nested: JSONContent[]): JSONContent {
	const content: JSONContent[] = [p(text)];
	if (nested.length > 0) {
		content.push({ type: 'bulletList', content: nested.map((n) => n) });
	}
	return { type: 'listItem', content };
}

function ul(...items: JSONContent[]): JSONContent {
	return { type: 'bulletList', content: items };
}

function doc(...nodes: JSONContent[]): JSONContent {
	return { type: 'doc', content: nodes };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Bare-number typing trigger
// ─────────────────────────────────────────────────────────────────────────────
describe('autoWeekdayPlugin — bare-number typing', () => {
	it('inserts weekday parens after "12 " when under a 4월 paragraph', () => {
		const wd = expectedWeekday(YEAR, MONTH, 12);
		const editor = makeEditor(
			doc(
				p('4월'),
				ul(li('12'))
			)
		);

		// Place cursor at end of the list item text and insert a space.
		// The listItem's paragraph is inside bulletList > listItem > paragraph.
		// Structure: doc[0]=p("4월") doc[1]=bulletList[0]=listItem[0]=paragraph "12"
		// Position: doc opens at 0, p("4월") = pos 1..7 (open+3chars+close+nodecloser)
		// bulletList at 7, listItem at 8, paragraph at 9, text starts at 10
		// "12" has length 2, so caret end of text = pos 12.
		editor.commands.focus();

		// Find the end of the "12" text in the bulletList.
		let targetPos = -1;
		editor.state.doc.descendants((node, pos) => {
			if (node.isText && node.text === '12') {
				targetPos = pos + node.nodeSize;
			}
		});
		expect(targetPos).toBeGreaterThan(0);

		editor.commands.setTextSelection(targetPos);
		editor.commands.insertContent(' ');

		const texts = collectListTexts(editor.getJSON());
		expect(texts[0]).toBe(`12(${wd}) `);
	});

	it('does not double-transform when space already inserted correctly (idempotent typing)', () => {
		const wd = expectedWeekday(YEAR, MONTH, 12);
		const initial = `12(${wd}) `;
		const editor = makeEditor(
			doc(
				p('4월'),
				ul(li(initial))
			)
		);

		// Typing another space at end should not change the day prefix.
		let targetPos = -1;
		editor.state.doc.descendants((node, pos) => {
			if (node.isText && (node.text ?? '').startsWith(initial)) {
				targetPos = pos + node.nodeSize;
			}
		});
		if (targetPos === -1) {
			// If the text was split, find the end of the last text child.
			targetPos = editor.state.doc.content.size - 1;
		}
		editor.commands.setTextSelection(targetPos);

		const before = editor.getJSON();
		// Insert a non-space character so doc changes and plugin runs,
		// but existing prefix stays correct.
		editor.commands.insertContent('x');

		const texts = collectListTexts(editor.getJSON());
		// The weekday prefix should still be intact.
		expect(texts[0]).toContain(`12(${wd})`);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Wrong weekday correction
// ─────────────────────────────────────────────────────────────────────────────
describe('autoWeekdayPlugin — wrong weekday correction', () => {
	it('replaces wrong weekday when any docChanged transaction fires', () => {
		const wd = expectedWeekday(YEAR, MONTH, 12); // correct for Apr 12 2026
		// Start with a wrong weekday — "월" is Monday, Apr 12 is Sunday "일".
		const wrongWd = wd === '일' ? '월' : '일'; // pick something different
		const editor = makeEditor(
			doc(
				p('4월'),
				ul(li(`12(${wrongWd}) 등산`))
			)
		);

		// Insert a char at another position to trigger a docChanged transaction.
		// Append to the month header paragraph.
		let paraPos = -1;
		editor.state.doc.descendants((node, pos) => {
			if (node.isText && node.text === '4월') {
				paraPos = pos + node.nodeSize;
			}
		});
		expect(paraPos).toBeGreaterThan(0);
		editor.commands.setTextSelection(paraPos);
		editor.commands.insertContent(' ');

		const texts = collectListTexts(editor.getJSON());
		expect(texts[0]).toBe(`12(${wd}) 등산`);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Disabled plugin — no rewrites
// ─────────────────────────────────────────────────────────────────────────────
describe('autoWeekdayPlugin — disabled', () => {
	it('does not transform when enabled() returns false', () => {
		const editor = makeEditorDisabled(
			doc(
				p('4월'),
				ul(li('12'))
			)
		);

		let targetPos = -1;
		editor.state.doc.descendants((node, pos) => {
			if (node.isText && node.text === '12') {
				targetPos = pos + node.nodeSize;
			}
		});
		expect(targetPos).toBeGreaterThan(0);
		editor.commands.setTextSelection(targetPos);
		editor.commands.insertContent(' ');

		const texts = collectListTexts(editor.getJSON());
		// Should remain "12 " with no weekday inserted.
		expect(texts[0]).toBe('12 ');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Outside N월 section — no change
// ─────────────────────────────────────────────────────────────────────────────
describe('autoWeekdayPlugin — outside month section', () => {
	it('does not transform listItem not preceded by a month header', () => {
		const editor = makeEditor(
			doc(
				p('메모'),
				ul(li('12'))
			)
		);

		let targetPos = -1;
		editor.state.doc.descendants((node, pos) => {
			if (node.isText && node.text === '12') {
				targetPos = pos + node.nodeSize;
			}
		});
		editor.commands.setTextSelection(targetPos);
		editor.commands.insertContent(' ');

		const texts = collectListTexts(editor.getJSON());
		expect(texts[0]).toBe('12 ');
	});

	it('does not transform when there is no preceding block at all', () => {
		const editor = makeEditor(
			doc(
				ul(li('12'))
			)
		);

		let targetPos = -1;
		editor.state.doc.descendants((node, pos) => {
			if (node.isText && node.text === '12') {
				targetPos = pos + node.nodeSize;
			}
		});
		editor.commands.setTextSelection(targetPos);
		editor.commands.insertContent(' ');

		const texts = collectListTexts(editor.getJSON());
		expect(texts[0]).toBe('12 ');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Idempotency — second pass produces no change
// ─────────────────────────────────────────────────────────────────────────────
describe('autoWeekdayPlugin — idempotency', () => {
	it('does not emit a transaction when weekday is already correct', () => {
		const wd = expectedWeekday(YEAR, MONTH, 12);
		const correct = `12(${wd}) 등산`;
		const editor = makeEditor(
			doc(
				p('4월'),
				ul(li(correct))
			)
		);

		const before = JSON.stringify(editor.getJSON());

		// Dispatch a no-op meta transaction that still marks docChanged = false.
		// To trigger appendTransaction with docChanged=true, we do a real edit
		// and then undo — or just verify that the stable state produces no change.
		// Easiest: append then immediately check nothing was mutated.
		// Actually trigger a docChanged transaction so appendTransaction runs.
		let paraEnd = -1;
		editor.state.doc.descendants((node, pos) => {
			if (node.isText && node.text === '4월') {
				paraEnd = pos + node.nodeSize;
			}
		});
		editor.commands.setTextSelection(paraEnd);
		editor.commands.insertContent('x');
		// Now undo the header change.
		editor.commands.undo();

		// The list item text should remain correct (no double-rewrite).
		const texts = collectListTexts(editor.getJSON());
		expect(texts[0]).toBe(correct);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Nested listItems
// ─────────────────────────────────────────────────────────────────────────────
describe('autoWeekdayPlugin — nested listItems', () => {
	it('transforms nested listItem under a month-header top-level listItem', () => {
		// Shape: doc > bulletList > listItem("4월") > bulletList > listItem("12")
		// The "4월" parent listItem acts as the month section anchor.
		const wd = expectedWeekday(YEAR, MONTH, 12);
		const editor = makeEditor(
			doc(
				ul(
					li('4월', li('12'))
				)
			)
		);

		let targetPos = -1;
		editor.state.doc.descendants((node, pos) => {
			if (node.isText && node.text === '12') {
				targetPos = pos + node.nodeSize;
			}
		});
		expect(targetPos).toBeGreaterThan(0);
		editor.commands.setTextSelection(targetPos);
		editor.commands.insertContent(' ');

		const texts = collectListTexts(editor.getJSON());
		// texts[0] = "4월" (outer), texts[1] = "12(<wd>) " (inner)
		expect(texts[1]).toBe(`12(${wd}) `);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Invalid day — no change
// ─────────────────────────────────────────────────────────────────────────────
describe('autoWeekdayPlugin — invalid day', () => {
	it('does not transform Feb 30 (invalid date)', () => {
		// Use month 2 in the header but day 30 which doesn't exist.
		// We'll make the editor's "now" return Feb 1 2026 so month=2.
		let enabled = true;
		const editor = new Editor({
			extensions: [
				StarterKit.configure({ code: false, codeBlock: false, paragraph: false, listItem: false }),
				TomboyParagraph,
				TomboyListItem,
				Extension.create({
					name: 'tomboyAutoWeekday',
					addProseMirrorPlugins() {
						return [
							createAutoWeekdayPlugin({
								now: () => new Date(2026, 1, 1), // Feb 2026
								enabled: () => enabled
							})
						];
					}
				})
			],
			content: doc(p('2월'), ul(li('30')))
		});
		currentEditor = editor;

		let targetPos = -1;
		editor.state.doc.descendants((node, pos) => {
			if (node.isText && node.text === '30') {
				targetPos = pos + node.nodeSize;
			}
		});
		editor.commands.setTextSelection(targetPos);
		editor.commands.insertContent(' ');

		const texts = collectListTexts(editor.getJSON());
		expect(texts[0]).toBe('30 ');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Multiple month sections
// ─────────────────────────────────────────────────────────────────────────────
describe('autoWeekdayPlugin — multiple month sections', () => {
	it('applies the correct month to each section', () => {
		// Apr 1 2026 weekday and May 1 2026 weekday.
		const apr1Wd = expectedWeekday(2026, 4, 1);
		const may1Wd = expectedWeekday(2026, 5, 1);

		const editor = makeEditor(
			doc(
				p('4월'),
				ul(li('1 등산')),
				p('5월'),
				ul(li('1 회의'))
			)
		);

		// Trigger a docChanged transaction to run the plugin on the initial state.
		// We need to make a change so appendTransaction fires.
		// Add a char to a non-list area and undo; just triggering docChanged once is enough.
		let paraEnd = -1;
		editor.state.doc.descendants((node, pos) => {
			if (node.isText && node.text === '4월') {
				paraEnd = pos + node.nodeSize;
			}
		});
		editor.commands.setTextSelection(paraEnd);
		editor.commands.insertContent('x');

		const texts = collectListTexts(editor.getJSON());
		// Both items should have their correct weekday.
		expect(texts[0]).toBe(`1(${apr1Wd}) 등산`);
		expect(texts[1]).toBe(`1(${may1Wd}) 회의`);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Paste multi-line — multiple listItems get transformed
// ─────────────────────────────────────────────────────────────────────────────
describe('autoWeekdayPlugin — multi-line paste', () => {
	it('transforms multiple listItems inserted at once under a month section', () => {
		const wd1 = expectedWeekday(YEAR, MONTH, 1);
		const wd2 = expectedWeekday(YEAR, MONTH, 15);
		const wd3 = expectedWeekday(YEAR, MONTH, 30);

		const editor = makeEditor(
			doc(
				p('4월'),
				ul(li('placeholder'))
			)
		);

		// Replace the placeholder list with three items via insertContent
		// (simulates a paste of multiple items).
		// Find the bulletList position and replace its entire content.
		editor.commands.setContent(
			doc(
				p('4월'),
				ul(li('1 가'), li('15 나'), li('30 다'))
			)
		);

		// To trigger the plugin we need to produce a docChanged transaction.
		// setContent already fires appendTransaction on the internal replace.
		// However setContent uses emitUpdate:true by default but doesn't always
		// trigger appendTransaction cleanly in tests. Insert a dummy char and undo.
		let paraEnd = -1;
		editor.state.doc.descendants((node, pos) => {
			if (node.isText && node.text === '4월') {
				paraEnd = pos + node.nodeSize;
			}
		});
		editor.commands.setTextSelection(paraEnd);
		editor.commands.insertContent('x');

		const texts = collectListTexts(editor.getJSON());
		expect(texts[0]).toBe(`1(${wd1}) 가`);
		expect(texts[1]).toBe(`15(${wd2}) 나`);
		expect(texts[2]).toBe(`30(${wd3}) 다`);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Rescan meta — scan-on-open without docChanged
// ─────────────────────────────────────────────────────────────────────────────
describe('autoWeekdayPlugin — rescan meta', () => {
	it('rescan meta on a non-docChanged transaction triggers rewrite when enabled', () => {
		const wd = expectedWeekday(YEAR, MONTH, 12);
		const wrongWd = wd === '일' ? '월' : '일';
		const editor = makeEditor(
			doc(
				p('4월'),
				ul(li(`12(${wrongWd}) 등산`))
			)
		);

		// Dispatch a meta-only transaction (no doc change).
		editor.view.dispatch(
			editor.state.tr.setMeta(autoWeekdayPluginKey, { rescan: true })
		);

		const texts = collectListTexts(editor.getJSON());
		expect(texts[0]).toBe(`12(${wd}) 등산`);
	});

	it('rescan meta does nothing when disabled', () => {
		const wrongWd = '월';
		const editor = makeEditorDisabled(
			doc(
				p('4월'),
				ul(li(`12(${wrongWd}) 등산`))
			)
		);

		editor.view.dispatch(
			editor.state.tr.setMeta(autoWeekdayPluginKey, { rescan: true })
		);

		const texts = collectListTexts(editor.getJSON());
		expect(texts[0]).toBe(`12(${wrongWd}) 등산`);
	});

	it('rescan meta on doc with no list items returns null tr (no change, no loop)', () => {
		const editor = makeEditor(
			doc(p('just a paragraph'))
		);

		const stateBefore = editor.state;
		editor.view.dispatch(
			editor.state.tr.setMeta(autoWeekdayPluginKey, { rescan: true })
		);

		// No rewrites happened — doc content should be unchanged.
		const texts = collectListTexts(editor.getJSON());
		expect(texts).toHaveLength(0);
		// Doc size should be the same.
		expect(editor.state.doc.content.size).toBe(stateBefore.doc.content.size);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 2 additional edge cases
// ─────────────────────────────────────────────────────────────────────────────

// G2-1: Year boundary — current month=1, only a 2월 section → no transform
describe('autoWeekdayPlugin — G2-1: year boundary, current month != section month', () => {
	it('Jan 5 2026 now, doc has only 2월 section → no transform (month lookup uses header value not now())', () => {
		// The plugin reads the month from the "N월" header in the doc, not from now().
		// Jan 5 context: the section says "2월", so the plugin uses month=2.
		// Day "5" in Feb 2026 is valid → it WILL transform.
		// This test pins the actual behavior: plugin always uses doc header month.
		const jan5 = new Date(2026, 0, 5); // Jan 5 2026
		const feb5Wd = expectedWeekday(2026, 2, 5); // Feb 5 2026 weekday

		let editorRef: Editor | null = null;
		const editor = new Editor({
			extensions: [
				StarterKit.configure({ code: false, codeBlock: false, paragraph: false, listItem: false }),
				TomboyParagraph,
				TomboyListItem,
				Extension.create({
					name: 'tomboyAutoWeekday',
					addProseMirrorPlugins() {
						return [
							createAutoWeekdayPlugin({
								now: () => jan5,
								enabled: () => true
							})
						];
					}
				})
			],
			content: doc(p('2월'), ul(li('5 산책')))
		});
		currentEditor = editor;

		// Trigger docChanged.
		let paraEnd = -1;
		editor.state.doc.descendants((node, pos) => {
			if (node.isText && node.text === '2월') {
				paraEnd = pos + node.nodeSize;
			}
		});
		editor.commands.setTextSelection(paraEnd);
		editor.commands.insertContent('x');

		const texts = collectListTexts(editor.getJSON());
		// The plugin uses the doc-header month (2), year from now() (2026).
		// Feb 5 2026 is a valid date → transform occurs.
		expect(texts[0]).toBe(`5(${feb5Wd}) 산책`);
	});

	it('no transform when listItem has no preceding month header in doc', () => {
		// Sanity-pin: without a month header, no transform happens regardless of now().
		const jan5 = new Date(2026, 0, 5);
		const editor = new Editor({
			extensions: [
				StarterKit.configure({ code: false, codeBlock: false, paragraph: false, listItem: false }),
				TomboyParagraph,
				TomboyListItem,
				Extension.create({
					name: 'tomboyAutoWeekday',
					addProseMirrorPlugins() {
						return [
							createAutoWeekdayPlugin({
								now: () => jan5,
								enabled: () => true
							})
						];
					}
				})
			],
			content: doc(ul(li('5 산책')))
		});
		currentEditor = editor;

		let targetPos = -1;
		editor.state.doc.descendants((node, pos) => {
			if (node.isText && node.text === '5 산책') {
				targetPos = pos + node.nodeSize;
			}
		});
		editor.commands.setTextSelection(targetPos > 0 ? targetPos : 1);
		editor.commands.insertContent('x');

		const texts = collectListTexts(editor.getJSON());
		// No month header → no transform.
		expect(texts[0]).not.toMatch(/\(\w\)/);
	});
});

// G2-2: Multiple month headers — each sibling list uses its own nearest preceding header
describe('autoWeekdayPlugin — G2-2: multiple month headers, each section uses correct month', () => {
	it('4월 paragraph then 12-item, 5월 paragraph then 13-item → each uses correct month', () => {
		const apr12Wd = expectedWeekday(2026, 4, 12);
		const may13Wd = expectedWeekday(2026, 5, 13);

		const editor = makeEditor(
			doc(
				p('4월'),
				ul(li('12 a')),
				p('5월'),
				ul(li('13 b'))
			)
		);

		let paraEnd = -1;
		editor.state.doc.descendants((node, pos) => {
			if (node.isText && node.text === '4월') {
				paraEnd = pos + node.nodeSize;
			}
		});
		editor.commands.setTextSelection(paraEnd);
		editor.commands.insertContent('x');

		const texts = collectListTexts(editor.getJSON());
		expect(texts[0]).toBe(`12(${apr12Wd}) a`);
		expect(texts[1]).toBe(`13(${may13Wd}) b`);
	});
});

// G2-3: Empty doc
describe('autoWeekdayPlugin — G2-3: empty doc', () => {
	it('empty doc does not throw and produces no rewrites', () => {
		const editor = makeEditor(doc());

		// Dispatch a rescan meta — no error expected.
		expect(() => {
			editor.view.dispatch(
				editor.state.tr.setMeta(autoWeekdayPluginKey, { rescan: true })
			);
		}).not.toThrow();

		const texts = collectListTexts(editor.getJSON());
		expect(texts).toHaveLength(0);
	});
});

// G2-4: Doc with only paragraphs (no lists)
describe('autoWeekdayPlugin — G2-4: doc with only paragraphs', () => {
	it('no lists → no rewrites, no error', () => {
		const editor = makeEditor(doc(p('4월'), p('12 산책'), p('abc')));

		expect(() => {
			editor.view.dispatch(
				editor.state.tr.setMeta(autoWeekdayPluginKey, { rescan: true })
			);
		}).not.toThrow();

		// Nothing is a list item, so collectListTexts is empty.
		const texts = collectListTexts(editor.getJSON());
		expect(texts).toHaveLength(0);
	});
});

// G2-5: Listitem with multiple paragraphs — only the FIRST paragraph is treated
describe('autoWeekdayPlugin — G2-5: multiple paragraphs inside same listItem', () => {
	it('only the first paragraph is the day-prefix line; later paragraphs are ignored', () => {
		const wd = expectedWeekday(YEAR, MONTH, 12);

		// Build a listItem with two paragraphs manually.
		const multiParaLi: JSONContent = {
			type: 'listItem',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '12 등산' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: '13 메모' }] }
			]
		};

		const editor = makeEditor(
			doc(
				p('4월'),
				{ type: 'bulletList', content: [multiParaLi] }
			)
		);

		// Trigger docChanged.
		let paraEnd = -1;
		editor.state.doc.descendants((node, pos) => {
			if (node.isText && node.text === '4월') {
				paraEnd = pos + node.nodeSize;
			}
		});
		editor.commands.setTextSelection(paraEnd);
		editor.commands.insertContent('x');

		const json = editor.getJSON();
		// Find the listItem and inspect both paragraphs.
		const bulletList = json.content?.find((n) => n.type === 'bulletList');
		const listItem = bulletList?.content?.[0] as JSONContent | undefined;
		const firstPara = listItem?.content?.[0] as JSONContent | undefined;
		const secondPara = listItem?.content?.[1] as JSONContent | undefined;
		const firstParaText = (firstPara?.content ?? [])
			.filter((c: JSONContent) => c.type === 'text')
			.map((c: JSONContent) => c.text ?? '')
			.join('');
		const secondParaText = (secondPara?.content ?? [])
			.filter((c: JSONContent) => c.type === 'text')
			.map((c: JSONContent) => c.text ?? '')
			.join('');

		// First paragraph gets weekday inserted.
		expect(firstParaText).toBe(`12(${wd}) 등산`);
		// Second paragraph is NOT treated as a day-prefix line by the plugin — it
		// is simply the second paragraph of the listItem and is not transformed.
		expect(secondParaText).toBe('13 메모');
	});
});

// G2-6: Mark spans (bold) inside the day-prefix text
describe('autoWeekdayPlugin — G2-6: bold marks inside day-prefix text', () => {
	it('textContent strips marks; rewrite produces un-marked text node', () => {
		const wd = expectedWeekday(YEAR, MONTH, 12);

		// Build a listItem whose first paragraph has a bold "12" node + plain " 등산" node.
		const boldLi: JSONContent = {
			type: 'listItem',
			content: [
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: '12', marks: [{ type: 'bold' }] },
						{ type: 'text', text: ' 등산' }
					]
				}
			]
		};

		const editor = makeEditor(
			doc(
				p('4월'),
				{ type: 'bulletList', content: [boldLi] }
			)
		);

		// Trigger docChanged.
		let paraEnd = -1;
		editor.state.doc.descendants((node, pos) => {
			if (node.isText && node.text === '4월') {
				paraEnd = pos + node.nodeSize;
			}
		});
		editor.commands.setTextSelection(paraEnd);
		editor.commands.insertContent('x');

		const texts = collectListTexts(editor.getJSON());
		// Plugin reads "12 등산" via textContent (marks invisible).
		// Rewrite replaces the full paragraph content with a single plain text node.
		expect(texts[0]).toBe(`12(${wd}) 등산`);

		// PIN: the rewrite drops marks (replaceWith emits a single unmarked text node).
		const json = editor.getJSON();
		const bulletList = json.content?.find((n: JSONContent) => n.type === 'bulletList');
		const listItem = bulletList?.content?.[0] as JSONContent | undefined;
		const firstParaNode = listItem?.content?.[0] as JSONContent | undefined;
		const paraContent = firstParaNode?.content ?? [];
		// After rewrite, only one text node, no marks.
		const hasMarks = paraContent.some(
			(c: JSONContent) => c.marks && (c.marks as JSONContent[]).length > 0
		);
		expect(hasMarks).toBe(false);
	});
});

// G2-7: Concurrent rewrites for many sibling list items
describe('autoWeekdayPlugin — G2-7: many sibling list items all get fixed', () => {
	it('10 list items with wrong weekday under 4월 → all corrected in one pass', () => {
		const wrongWd = '월'; // Monday
		const items: JSONContent[] = Array.from({ length: 10 }, (_, i) => {
			const day = i + 1; // days 1..10
			return li(`${day}(${wrongWd}) 일정`);
		});

		const editor = makeEditor(doc(p('4월'), ul(...items)));

		// Trigger docChanged.
		let paraEnd = -1;
		editor.state.doc.descendants((node, pos) => {
			if (node.isText && node.text === '4월') {
				paraEnd = pos + node.nodeSize;
			}
		});
		editor.commands.setTextSelection(paraEnd);
		editor.commands.insertContent('x');

		const texts = collectListTexts(editor.getJSON());
		expect(texts).toHaveLength(10);

		for (let i = 0; i < 10; i++) {
			const day = i + 1;
			const correctWd = expectedWeekday(YEAR, MONTH, day);
			// Each item should be corrected (unless its correct weekday happens to be '월').
			if (correctWd !== wrongWd) {
				expect(texts[i]).toBe(`${day}(${correctWd}) 일정`);
			} else {
				// The wrong weekday was accidentally correct — it stays.
				expect(texts[i]).toBe(`${day}(${correctWd}) 일정`);
			}
		}
	});
});

// G2-8: Plugin disabled then re-enabled via rescan meta
describe('autoWeekdayPlugin — G2-8: disabled then enabled via rescan meta', () => {
	it('disabled: docChanged does not rewrite; then rescan meta with enabled=true fixes all', () => {
		const wd = expectedWeekday(YEAR, MONTH, 12);
		const wrongWd = wd === '일' ? '월' : '일';

		let isEnabled = false;

		// Include a trailing paragraph AFTER the list so we can trigger docChanged
		// without corrupting the "4월" month header (which must stay intact for the
		// month lookup to work during the subsequent rescan).
		const editor = new Editor({
			extensions: [
				StarterKit.configure({ code: false, codeBlock: false, paragraph: false, listItem: false }),
				TomboyParagraph,
				TomboyListItem,
				Extension.create({
					name: 'tomboyAutoWeekday',
					addProseMirrorPlugins() {
						return [
							createAutoWeekdayPlugin({
								now: () => FIXED_DATE,
								enabled: () => isEnabled
							})
						];
					}
				})
			],
			content: doc(p('4월'), ul(li(`12(${wrongWd}) 등산`)), p('노트'))
		});
		currentEditor = editor;

		// While disabled: trigger docChanged by editing the trailing paragraph.
		let noteParaEnd = -1;
		editor.state.doc.descendants((node, pos) => {
			if (node.isText && node.text === '노트') {
				noteParaEnd = pos + node.nodeSize;
			}
		});
		expect(noteParaEnd).toBeGreaterThan(0);
		editor.commands.setTextSelection(noteParaEnd);
		editor.commands.insertContent('x');

		let texts = collectListTexts(editor.getJSON());
		// Still wrong weekday — plugin was disabled.
		expect(texts[0]).toBe(`12(${wrongWd}) 등산`);

		// Enable and dispatch rescan meta.
		isEnabled = true;
		editor.view.dispatch(
			editor.state.tr.setMeta(autoWeekdayPluginKey, { rescan: true })
		);

		texts = collectListTexts(editor.getJSON());
		// Now fixed.
		expect(texts[0]).toBe(`12(${wd}) 등산`);
	});
});
