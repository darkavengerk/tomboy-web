import { Mark, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
	interface Commands<ReturnType> {
		tomboyMonospace: {
			setTomboyMonospace: () => ReturnType;
			toggleTomboyMonospace: () => ReturnType;
			unsetTomboyMonospace: () => ReturnType;
		};
	}
}

export const TomboyMonospace = Mark.create({
	name: 'tomboyMonospace',

	addOptions() {
		return {
			HTMLAttributes: {}
		};
	},

	parseHTML() {
		return [{ tag: 'code.tomboy-monospace' }, { tag: 'span.tomboy-monospace' }];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			'code',
			mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
				class: 'tomboy-monospace'
			}),
			0
		];
	},

	addCommands() {
		return {
			setTomboyMonospace:
				() =>
				({ commands }) => {
					return commands.setMark(this.name);
				},
			toggleTomboyMonospace:
				() =>
				({ commands }) => {
					return commands.toggleMark(this.name);
				},
			unsetTomboyMonospace:
				() =>
				({ commands }) => {
					return commands.unsetMark(this.name);
				}
		};
	},

	addKeyboardShortcuts() {
		return {
			'Mod-Shift-m': () => this.editor.commands.toggleTomboyMonospace()
		};
	}
});
