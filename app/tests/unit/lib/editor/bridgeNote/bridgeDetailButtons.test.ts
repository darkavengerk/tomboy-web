import { describe, it, expect, vi, afterEach } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { createBridgeNotePlugin } from '$lib/editor/bridgeNote/bridgeNotePlugin.js';

const openSpy = vi.fn();
vi.mock('$lib/bridgeStatus/detail/openBridgeDetail.js', () => ({
	openBridgeDetail: (k: string) => openSpy(k)
}));

function makeEditor(title: string): Editor {
	const el = document.createElement('div');
	document.body.appendChild(el);
	const BridgeExt = Extension.create({
		name: 'bridgeNoteExt',
		addProseMirrorPlugins() {
			return [createBridgeNotePlugin()];
		}
	});
	return new Editor({
		element: el,
		extensions: [StarterKit, BridgeExt],
		content: `<p>${title}</p><p>body</p>`
	});
}

afterEach(() => {
	openSpy.mockReset();
	document.body.innerHTML = '';
});

describe('bridge detail buttons', () => {
	it('renders 일기 detail button on a 브릿지:: note and wires click', async () => {
		const ed = makeEditor('브릿지::라즈베리파이');
		const btn = ed.view.dom.querySelector('.tomboy-bridge-detail') as HTMLButtonElement;
		expect(btn).toBeTruthy();
		expect(btn.textContent).toContain('📓 일기');
		btn.click();
		expect(openSpy).toHaveBeenCalledWith('diary');
		ed.destroy();
	});

	it('no widget on a non-bridge note', () => {
		const ed = makeEditor('그냥 노트');
		expect(ed.view.dom.querySelector('.tomboy-bridge-detail')).toBeNull();
		ed.destroy();
	});
});
