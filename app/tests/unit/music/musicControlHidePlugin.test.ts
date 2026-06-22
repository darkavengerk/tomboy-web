import { describe, it, expect, afterEach } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { createMusicControlHidePlugin } from '$lib/editor/musicControlNote/musicControlHidePlugin.js';
import { MUSIC_CONTROL_MARKER } from '$lib/music/musicControlNote.js';

let editor: Editor | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
	editor?.destroy();
	editor = null;
	host?.remove();
	host = null;
});

function mount(enabled: boolean) {
	const ext = Extension.create({
		name: 'mcHideTest',
		addProseMirrorPlugins() {
			return [createMusicControlHidePlugin({ enabled: () => enabled })];
		}
	});
	host = document.createElement('div');
	document.body.appendChild(host);
	editor = new Editor({
		element: host,
		extensions: [StarterKit, ext],
		content: {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '음악제어::공유' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: '보이는 메모' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: `${MUSIC_CONTROL_MARKER}[{"deviceId":"a"}]` }] }
			]
		}
	});
	return editor;
}

describe('musicControlHidePlugin', () => {
	it('hides the marker paragraph when enabled', () => {
		mount(true);
		const hidden = editor!.view.dom.querySelector('.tomboy-music-control-hidden');
		expect(hidden).not.toBeNull();
		expect(hidden!.textContent).toContain(MUSIC_CONTROL_MARKER);
	});

	it('does not hide when disabled', () => {
		mount(false);
		expect(editor!.view.dom.querySelector('.tomboy-music-control-hidden')).toBeNull();
	});
});
