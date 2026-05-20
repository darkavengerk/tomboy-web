import { Extension } from '@tiptap/core';

import { createBlockquotePlugin, blockquotePluginKey } from './plugin.js';

export { isQuotedParagraphText, findQuotedParagraphs } from './blockquote.js';
export type { QuotedParagraph } from './blockquote.js';
export { blockquotePluginKey };

export const TomboyBlockquote = Extension.create({
	name: 'tomboyBlockquote',
	addProseMirrorPlugins() {
		return [createBlockquotePlugin()];
	}
});
