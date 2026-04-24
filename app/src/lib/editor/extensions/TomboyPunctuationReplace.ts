import { Extension, InputRule } from '@tiptap/core';

/**
 * Auto-replaces `.,` with `·` (U+00B7 middle dot) as the user types.
 * Fires on the second character (`,`) via a ProseMirror input rule, so
 * Ctrl+Z reverts to the original two characters.
 */
export const TomboyPunctuationReplace = Extension.create({
	name: 'tomboyPunctuationReplace',

	addInputRules() {
		return [
			new InputRule({
				find: /\.,$/,
				handler: ({ state, range }) => {
					state.tr.insertText('·', range.from, range.to);
				},
			}),
		];
	},
});
