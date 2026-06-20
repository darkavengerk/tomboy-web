import { Extension } from '@tiptap/core';
import {
	createMusicExtractNotePlugin,
	type MusicExtractPluginOptions
} from './musicExtractNotePlugin.js';

export const TomboyMusicExtractNote = Extension.create<MusicExtractPluginOptions>({
	name: 'tomboyMusicExtractNote',
	addOptions() {
		return { oninternallink: undefined };
	},
	addProseMirrorPlugins() {
		return [createMusicExtractNotePlugin({ oninternallink: this.options.oninternallink })];
	}
});
export {
	createMusicExtractNotePlugin,
	musicExtractNotePluginKey,
	type MusicExtractPluginOptions
} from './musicExtractNotePlugin.js';
