import { Mark, mergeAttributes } from '@tiptap/core';
import type { TitleEntry } from '../autoLink/findTitleMatches.js';
import { createAutoLinkPlugin } from '../autoLink/autoLinkPlugin.js';

declare module '@tiptap/core' {
	interface Commands<ReturnType> {
		tomboyInternalLink: {
			setTomboyInternalLink: (attrs: { target: string }) => ReturnType;
			unsetTomboyInternalLink: () => ReturnType;
		};
	}
}

export interface TomboyInternalLinkOptions {
	HTMLAttributes: Record<string, unknown>;
	onLinkClick: (target: string) => void;
	/** Returns the current note-title list used for auto-linking. */
	getTitles: () => TitleEntry[];
	/** Returns the guid of the note being edited (excluded from auto-links). */
	getCurrentGuid: () => string | null;
}

export const TomboyInternalLink = Mark.create<TomboyInternalLinkOptions>({
	name: 'tomboyInternalLink',

	addOptions() {
		return {
			HTMLAttributes: {},
			onLinkClick: (_target: string) => {},
			getTitles: () => [],
			getCurrentGuid: () => null
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
	},

	addProseMirrorPlugins() {
		return [
			createAutoLinkPlugin({
				markType: this.type,
				getTitles: () => this.options.getTitles(),
				getCurrentGuid: () => this.options.getCurrentGuid()
			})
		];
	}
});
