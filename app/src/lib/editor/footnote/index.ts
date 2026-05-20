import { Extension } from '@tiptap/core';

import {
	createFootnotePlugin,
	footnotePluginKey,
	type FootnotePluginOptions
} from './plugin.js';

export {
	findFootnoteMatches,
	findFootnoteAt,
	findFootnotePartner
} from './footnotes.js';
export type { FootnoteMatch } from './footnotes.js';
export { footnotePluginKey };
export type { FootnotePluginOptions, FootnotePluginState } from './plugin.js';

export const TomboyFootnote = Extension.create<FootnotePluginOptions>({
	name: 'tomboyFootnote',
	addOptions() {
		return {
			onMissing: () => {}
		};
	},
	addProseMirrorPlugins() {
		return [createFootnotePlugin(this.options)];
	}
});
