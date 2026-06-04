import { Extension } from '@tiptap/core';
import { createMusicNotePlugin } from './musicNotePlugin.js';

export const TomboyMusicNote = Extension.create({
	name: 'tomboyMusicNote',
	addProseMirrorPlugins() {
		return [createMusicNotePlugin()];
	}
});

export { createMusicNotePlugin, musicNotePluginKey, buildMusicDecorations, handleTrackButtonClick } from './musicNotePlugin.js';
