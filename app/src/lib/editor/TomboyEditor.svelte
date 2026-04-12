<script lang="ts">
	import { onMount } from 'svelte';
	import { Editor } from '@tiptap/core';
	import StarterKit from '@tiptap/starter-kit';
	import Underline from '@tiptap/extension-underline';
	import Highlight from '@tiptap/extension-highlight';
	import Placeholder from '@tiptap/extension-placeholder';
	import { TomboySize } from './extensions/TomboySize.js';
	import { TomboyMonospace } from './extensions/TomboyMonospace.js';
	import { TomboyInternalLink } from './extensions/TomboyInternalLink.js';
	import { TomboyUrlLink } from './extensions/TomboyUrlLink.js';
	import { TomboyDatetime } from './extensions/TomboyDatetime.js';
	import { createTitleProvider } from './autoLink/titleProvider.js';
	import { autoLinkPluginKey } from './autoLink/autoLinkPlugin.js';
	import type { JSONContent } from '@tiptap/core';

	interface Props {
		content?: JSONContent;
		onchange?: (doc: JSONContent) => void;
		oninternallink?: (target: string) => void;
		currentGuid?: string | null;
	}

	let { content, onchange, oninternallink, currentGuid = null }: Props = $props();

	let editorElement: HTMLDivElement;
	let editor: Editor | null = $state(null);
	let prevContentStr = JSON.stringify(content ?? { type: 'doc', content: [{ type: 'paragraph' }] });

	onMount(() => {
		const titleProvider = createTitleProvider({ excludeGuid: currentGuid });
		// Populate titles asynchronously; the plugin reads via getTitles() so
		// late arrivals still auto-link pre-existing content via the refresh meta.
		void titleProvider.refresh();

		editor = new Editor({
			element: editorElement,
			extensions: [
				StarterKit.configure({
					// Disable code (we use tomboyMonospace instead)
					code: false,
					codeBlock: false
				}),
				Underline,
				Highlight.configure({ multicolor: false }),
				Placeholder.configure({ placeholder: 'Start typing...' }),
				TomboySize,
				TomboyMonospace,
				TomboyInternalLink.configure({
					onLinkClick: (target: string) => {
						oninternallink?.(target);
					},
					getTitles: () => titleProvider.getTitles(),
					getCurrentGuid: () => currentGuid
				}),
				TomboyUrlLink,
				TomboyDatetime
			],
			content: content ?? { type: 'doc', content: [{ type: 'paragraph' }] },
			onUpdate: ({ editor: ed }) => {
				const newDoc = ed.getJSON();
				const newStr = JSON.stringify(newDoc);
				if (newStr === prevContentStr) return;
				prevContentStr = newStr;
				onchange?.(newDoc);
			},
			editorProps: {
				handleClick: (view, pos, event) => {
					const target = (event.target as HTMLElement).closest('a[data-link-target]');
					if (target) {
						event.preventDefault();
						const linkTarget = target.getAttribute('data-link-target');
						if (linkTarget) {
							oninternallink?.(linkTarget);
						}
						return true;
					}
					return false;
				}
			}
		});

		// When the note list changes (another note created / renamed / deleted),
		// ask the plugin to re-scan the current doc so stale / newly-matching
		// spans are reconciled.
		const offChange = titleProvider.onChange(() => {
			const ed = editor;
			if (!ed) return;
			ed.view.dispatch(ed.state.tr.setMeta(autoLinkPluginKey, { refresh: true }));
		});

		return () => {
			offChange();
			titleProvider.dispose();
			editor?.destroy();
		};
	});

	export function getEditor(): Editor | null {
		return editor;
	}
</script>

<div bind:this={editorElement} class="tomboy-editor"></div>

<style>
	.tomboy-editor {
		flex: 1;
		overflow-y: auto;
		padding: 1rem;
		font-size: 16px;
		line-height: 1.6;
	}

	.tomboy-editor :global(.tiptap) {
		outline: none;
		min-height: 100%;
	}

	.tomboy-editor :global(.tiptap p) {
		margin: 0;
	}

	/* First paragraph = title */
	.tomboy-editor :global(.tiptap > p:first-child) {
		font-size: 1.4em;
		font-weight: bold;
		margin-bottom: 0.5em;
	}

	/* Tomboy size marks */
	.tomboy-editor :global(.tomboy-size-huge) {
		font-size: 1.6em;
		font-weight: bold;
	}

	.tomboy-editor :global(.tomboy-size-large) {
		font-size: 1.3em;
	}

	.tomboy-editor :global(.tomboy-size-small) {
		font-size: 0.85em;
	}

	/* Monospace */
	.tomboy-editor :global(.tomboy-monospace) {
		font-family: monospace;
		background: rgba(0, 0, 0, 0.06);
		padding: 0.1em 0.3em;
		border-radius: 3px;
	}

	/* Internal link */
	.tomboy-editor :global(.tomboy-link-internal) {
		color: #204a87;
		text-decoration: underline;
		cursor: pointer;
	}

	/* Broken link */
	.tomboy-editor :global(.tomboy-link-broken) {
		color: #888;
		text-decoration: line-through;
		cursor: default;
	}

	/* URL link */
	.tomboy-editor :global(.tomboy-link-url) {
		color: #3465a4;
		text-decoration: underline;
	}

	/* Highlight */
	.tomboy-editor :global(mark) {
		background-color: #fff176;
	}

	/* List items */
	.tomboy-editor :global(ul) {
		padding-left: 1.5em;
	}

	/* Placeholder */
	.tomboy-editor :global(.tiptap p.is-editor-empty:first-child::before) {
		color: #adb5bd;
		content: attr(data-placeholder);
		float: left;
		height: 0;
		pointer-events: none;
	}
</style>
