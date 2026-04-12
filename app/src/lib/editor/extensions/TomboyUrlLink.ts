import { Mark, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
	interface Commands<ReturnType> {
		tomboyUrlLink: {
			setTomboyUrlLink: (attrs: { href: string }) => ReturnType;
			unsetTomboyUrlLink: () => ReturnType;
		};
	}
}

export const TomboyUrlLink = Mark.create({
	name: 'tomboyUrlLink',

	addOptions() {
		return {
			HTMLAttributes: {}
		};
	},

	addAttributes() {
		return {
			href: {
				default: null,
				parseHTML: (element) => element.getAttribute('href'),
				renderHTML: (attributes) => ({
					href: attributes.href
				})
			}
		};
	},

	parseHTML() {
		return [{ tag: 'a.tomboy-link-url' }];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			'a',
			mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
				class: 'tomboy-link-url',
				target: '_blank',
				rel: 'noopener noreferrer'
			}),
			0
		];
	},

	addCommands() {
		return {
			setTomboyUrlLink:
				(attrs: { href: string }) =>
				({ commands }) => {
					return commands.setMark(this.name, attrs);
				},
			unsetTomboyUrlLink:
				() =>
				({ commands }) => {
					return commands.unsetMark(this.name);
				}
		};
	}
});
