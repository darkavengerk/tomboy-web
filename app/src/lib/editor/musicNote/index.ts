import { Extension } from '@tiptap/core';
import { createMusicNotePlugin } from './musicNotePlugin.js';

export const TomboyMusicNote = Extension.create<{ getGuid: () => string }>({
	name: 'tomboyMusicNote',
	addOptions() {
		return { getGuid: () => '' };
	},
	addProseMirrorPlugins() {
		return [createMusicNotePlugin(this.options.getGuid)];
	}
});

export { createMusicNotePlugin, musicNotePluginKey, buildMusicDecorations, handleTrackButtonClick } from './musicNotePlugin.js';
