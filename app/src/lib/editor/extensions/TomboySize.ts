import { Mark, mergeAttributes } from '@tiptap/core';

export type SizeLevel = 'huge' | 'large' | 'small';

declare module '@tiptap/core' {
	interface Commands<ReturnType> {
		tomboySize: {
			setTomboySize: (level: SizeLevel) => ReturnType;
			toggleTomboySize: (level: SizeLevel) => ReturnType;
			unsetTomboySize: () => ReturnType;
		};
	}
}

export const TomboySize = Mark.create({
	name: 'tomboySize',

	addOptions() {
		return {
			HTMLAttributes: {}
		};
	},

	addAttributes() {
		return {
			level: {
				default: 'huge',
				parseHTML: (element) => element.getAttribute('data-size-level'),
				renderHTML: (attributes) => ({
					'data-size-level': attributes.level
				})
			}
		};
	},

	parseHTML() {
		return [
			{ tag: 'span[data-size-level="huge"]', attrs: { level: 'huge' } },
			{ tag: 'span[data-size-level="large"]', attrs: { level: 'large' } },
			{ tag: 'span[data-size-level="small"]', attrs: { level: 'small' } }
		];
	},

	renderHTML({ HTMLAttributes }) {
		const level = HTMLAttributes['data-size-level'] || 'huge';
		return [
			'span',
			mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
				class: `tomboy-size-${level}`
			}),
			0
		];
	},

	addCommands() {
		return {
			setTomboySize:
				(level: SizeLevel) =>
				({ commands }) => {
					return commands.setMark(this.name, { level });
				},
			toggleTomboySize:
				(level: SizeLevel) =>
				({ commands }) => {
					return commands.toggleMark(this.name, { level });
				},
			unsetTomboySize:
				() =>
				({ commands }) => {
					return commands.unsetMark(this.name);
				}
		};
	}
});
