import { Extension } from '@tiptap/core';
import { createBridgeNotePlugin } from './bridgeNotePlugin.js';

/** `브릿지::` 노트에 ⟳ 갱신 버튼을 띄우는 확장. */
export const TomboyBridgeNote = Extension.create({
	name: 'tomboyBridgeNote',
	addProseMirrorPlugins() {
		return [createBridgeNotePlugin()];
	}
});
