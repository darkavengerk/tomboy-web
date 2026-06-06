import { Extension } from '@tiptap/core';
import { createMusicExtractNotePlugin } from './musicExtractNotePlugin.js';

export const TomboyMusicExtractNote = Extension.create({
	name: 'tomboyMusicExtractNote',
	addProseMirrorPlugins() {
		return [createMusicExtractNotePlugin()];
	}
});
export { createMusicExtractNotePlugin, musicExtractNotePluginKey } from './musicExtractNotePlugin.js';
