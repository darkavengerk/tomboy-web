import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyInternalLink } from '$lib/editor/extensions/TomboyInternalLink.js';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import { TomboyMonospace } from '$lib/editor/extensions/TomboyMonospace.js';
import { TomboySize } from '$lib/editor/extensions/TomboySize.js';
import { TomboyDatetime } from '$lib/editor/extensions/TomboyDatetime.js';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import {
	deserializeContent,
	serializeContent
} from '$lib/core/noteContentArchiver.js';
import { autoLinkPluginKey } from '$lib/editor/autoLink/autoLinkPlugin.js';
import type { TitleEntry } from '$lib/editor/autoLink/findTitleMatches.js';

let currentEditor: Editor | null = null;

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

interface MakeOpts {
	xml: string;
	titles?: TitleEntry[];
	currentGuid?: string | null;
}

function makeEditor(opts: MakeOpts): Editor {
	const titles = opts.titles ?? [];
	const currentGuid = opts.currentGuid ?? null;
	const editor = new Editor({
		extensions: [
			StarterKit.configure({
				code: false,
				codeBlock: false,
				paragraph: false,
				listItem: false
			}),
			TomboyParagraph,
			TomboyListItem,
			TomboySize,
			TomboyMonospace,
			// Register TomboyDatetime BEFORE TomboyInternalLink / TomboyUrlLink
			// so PM ranks datetime as the outer mark. Our archiver stores
			// marks outer→inner (matching TipTap's getJSON order); keeping
			// datetime outer preserves the semantic nesting Tomboy uses
			// (e.g. `<datetime><link:internal>X</link:internal></datetime>`).
			TomboyDatetime,
			TomboyInternalLink.configure({
				getTitles: () => titles,
				getCurrentGuid: () => currentGuid
			}),
			TomboyUrlLink
		],
		content: deserializeContent(opts.xml)
	});
	currentEditor = editor;
	return editor;
}

describe('load → refresh → serialize idempotence (spurious-save regression)', () => {
	it('a fresh editor re-emits the exact same XML (no normalisation drift)', () => {
		const xml =
			'<note-content version="0.1">' +
			'Title\n\n' +
			'body with <link:internal>Foo</link:internal> in it' +
			'</note-content>';
		const editor = makeEditor({ xml });
		const out = serializeContent(editor.getJSON());
		expect(out).toBe(xml);
	});

	it('dispatching a refresh tr does NOT dirty the doc when nothing needs to change', () => {
		const xml =
			'<note-content version="0.1">' +
			'Title\n\n' +
			'body with <link:internal>Foo</link:internal> in it' +
			'</note-content>';
		const editor = makeEditor({
			xml,
			titles: [{ titleLower: 'foo', original: 'Foo', guid: 'other' }],
			currentGuid: 'me'
		});

		const before = editor.getJSON();
		// Simulate titleProvider.onChange firing a refresh.
		editor.view.dispatch(editor.state.tr.setMeta(autoLinkPluginKey, { refresh: true }));
		const after = editor.getJSON();

		expect(after).toEqual(before);
	});

it('mark nesting: strikethrough over an internal link does NOT get re-wrapped with link outside', () => {
		const source =
			`<note-content version="0.1">T\n` +
			`<list><list-item dir="ltr">` +
			`<strikethrough>화실에서 <link:internal>보드게임</link:internal></strikethrough>` +
			`<strikethrough> 가져오기</strikethrough>` +
			`</list-item></list>` +
			`</note-content>`;
		const firstEditor = makeEditor({ xml: source });
		const firstOut = serializeContent(firstEditor.getJSON());
		// Must not produce `<link:internal><strikethrough>...</strikethrough></link:internal>`
		// — that would flip the semantic nesting (link becomes the span, strike
		// becomes inner) which is a visible mutation of user intent.
		expect(firstOut).not.toContain('<link:internal><strikethrough>');
		// Canonical: one continuous <strikethrough> wrapping text + link.
		expect(firstOut).toContain(
			'<strikethrough>화실에서 <link:internal>보드게임</link:internal> 가져오기</strikethrough>'
		);
	});

	it('chained <datetime> runs through the editor: canonical form stabilises after one save', () => {
		// Non-canonical source: multiple adjacent <datetime> elements that
		// Tomboy desktop would itself coalesce. First save normalises; every
		// subsequent save must be a byte-stable no-op.
		const source =
			`<note-content version="0.1">T\n` +
			`<list><list-item dir="ltr">` +
			`<datetime><link:internal>2021-07-27</link:internal></datetime>` +
			`<datetime>\n<link:internal>2021-09-13</link:internal></datetime>` +
			`<datetime>\n<link:internal>2021-10-17</link:internal></datetime>` +
			` tail` +
			`</list-item></list>` +
			`</note-content>`;
		const firstEditor = makeEditor({ xml: source });
		const firstOut = serializeContent(firstEditor.getJSON());
		const secondEditor = makeEditor({ xml: firstOut });
		const secondOut = serializeContent(secondEditor.getJSON());
		// The user's complaint: this must be a fixed point.
		expect(secondOut).toBe(firstOut);
	});

	it('full idempotence: parsed XML → editor → getJSON → serializeContent matches original', () => {
		// Realistic note with nested list + link + datetime.
		const xml =
			'<note-content version="0.1">' +
			'My Title\n\n' +
			'<list>' +
			'<list-item dir="ltr">outer\n' +
			'<list><list-item dir="ltr">inner <link:internal>Foo</link:internal>\n</list-item></list>' +
			'</list-item>' +
			'<list-item dir="ltr">tail</list-item>' +
			'</list>\n' +
			'note seen on <datetime>2024-12-18</datetime>.' +
			'</note-content>';

		const editor = makeEditor({
			xml,
			titles: [{ titleLower: 'foo', original: 'Foo', guid: 'foo-guid' }],
			currentGuid: 'me'
		});

		// Dispatch refresh — should be a no-op because all existing marks
		// match their targets and no new matches exist.
		editor.view.dispatch(editor.state.tr.setMeta(autoLinkPluginKey, { refresh: true }));

		const out = serializeContent(editor.getJSON());
		expect(out).toBe(xml);
	});

	it('getJSON() after mount is stable across a refresh dispatch (no-op change detection baseline)', () => {
		// The raw parsed JSON and the editor's getJSON() differ (PM reorders
		// keys and fills in default mark attrs). That is fine, because
		// TomboyEditor.svelte snapshots `prevContentStr` from `getJSON()`
		// right after mount — not from the parser output. This test is the
		// regression guard for that snapshot: a refresh meta dispatch must
		// produce a getJSON() equal to the post-mount snapshot so the
		// onUpdate dirty check is a true no-op and the note doesn't get
		// re-saved on every open.
		const xml =
			'<note-content version="0.1">' +
			'Title\n\n' +
			'body text with <bold>bold</bold> and <link:internal>Linked</link:internal>' +
			'</note-content>';
		const editor = makeEditor({
			xml,
			titles: [{ titleLower: 'linked', original: 'Linked', guid: 'linked-guid' }],
			currentGuid: 'me'
		});

		const initialSnapshot = JSON.stringify(editor.getJSON());

		editor.view.dispatch(editor.state.tr.setMeta(autoLinkPluginKey, { refresh: true }));
		const afterRefresh = JSON.stringify(editor.getJSON());

		expect(afterRefresh).toBe(initialSnapshot);
	});
});
