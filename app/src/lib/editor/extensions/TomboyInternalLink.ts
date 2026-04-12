import { Mark, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
	interface Commands<ReturnType> {
		tomboyInternalLink: {
			setTomboyInternalLink: (attrs: { target: string }) => ReturnType;
			unsetTomboyInternalLink: () => ReturnType;
		};
	}
}

export const TomboyInternalLink = Mark.create({
	name: 'tomboyInternalLink',

	addOptions() {
		return {
			HTMLAttributes: {},
			onLinkClick: (_target: string) => {}
		};
	},

	addAttributes() {
		return {
			target: {
				default: null,
				parseHTML: (element) => element.getAttribute('data-link-target'),
				renderHTML: (attributes) => ({
					'data-link-target': attributes.target
				})
			},
			broken: {
				default: false,
				parseHTML: (element) => element.getAttribute('data-broken') === 'true',
				renderHTML: (attributes) => {
					if (!attributes.broken) return {};
					return { 'data-broken': 'true' };
				}
			}
		};
	},

	parseHTML() {
		return [{ tag: 'a[data-link-target]' }];
	},

	renderHTML({ HTMLAttributes }) {
		const broken = HTMLAttributes['data-broken'] === 'true';
		return [
			'a',
			mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
				class: broken ? 'tomboy-link-broken' : 'tomboy-link-internal',
				href: '#'
			}),
			0
		];
	},

	addCommands() {
		return {
			setTomboyInternalLink:
				(attrs: { target: string }) =>
				({ commands }) => {
					return commands.setMark(this.name, attrs);
				},
			unsetTomboyInternalLink:
				() =>
				({ commands }) => {
					return commands.unsetMark(this.name);
				}
		};
	}
});
