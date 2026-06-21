import { Extension } from '@tiptap/core';
import { createMusicNotePlugin } from './musicNotePlugin.js';

export const TomboyMusicNote = Extension.create<{
	getGuid: () => string;
	getOrigin: () => string | null;
}>({
	name: 'tomboyMusicNote',
	addOptions() {
		return { getGuid: () => '', getOrigin: () => null };
	},
	addProseMirrorPlugins() {
		return [createMusicNotePlugin(this.options.getGuid, this.options.getOrigin)];
	}
});

export { createMusicNotePlugin, musicNotePluginKey, buildMusicDecorations, handleTrackButtonClick } from './musicNotePlugin.js';
