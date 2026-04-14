<script lang="ts">
	import { onMount } from "svelte";
	import { Editor } from "@tiptap/core";
	import StarterKit from "@tiptap/starter-kit";
	import Underline from "@tiptap/extension-underline";
	import Highlight from "@tiptap/extension-highlight";
	import Placeholder from "@tiptap/extension-placeholder";
	import { TomboySize } from "./extensions/TomboySize.js";
	import { TomboyMonospace } from "./extensions/TomboyMonospace.js";
	import { TomboyInternalLink } from "./extensions/TomboyInternalLink.js";
	import { TomboyUrlLink } from "./extensions/TomboyUrlLink.js";
	import { TomboyDatetime } from "./extensions/TomboyDatetime.js";
	import { TomboyListItem } from "./extensions/TomboyListItem.js";
	import { TomboyParagraph } from "./extensions/TomboyParagraph.js";
	import { createTitleProvider } from "./autoLink/titleProvider.js";
	import { autoLinkPluginKey } from "./autoLink/autoLinkPlugin.js";
	import type { JSONContent } from "@tiptap/core";

	interface Props {
		content?: JSONContent;
		onchange?: (doc: JSONContent) => void;
		oninternallink?: (target: string) => void;
		currentGuid?: string | null;
	}

	let {
		content,
		onchange,
		oninternallink,
		currentGuid = null,
	}: Props = $props();

	let editorElement: HTMLDivElement;
	let editor: Editor | null = $state(null);

	// Debounced dispatcher for the auto-link plugin's rescan. The plugin
	// runs in "deferred" mode (only scans on {refresh:true} meta), which
	// keeps the typing hot path cheap. We fire a single refresh after the
	// user has paused typing. Idle fallback via requestIdleCallback when
	// available so the scan doesn't steal a frame from active input.
	//
	// `full:true` is used when the title list changes out from under us
	// (another note created / renamed / deleted). That case requires a
	// whole-document rescan because any text might now match, unlike the
	// ordinary typing path where the plugin's own dirty-range tracking
	// lets us scan only around the edit.
	const AUTO_LINK_DEBOUNCE_MS = 1000;
	let autoLinkTimer: ReturnType<typeof setTimeout> | null = null;
	let autoLinkIdleHandle: number | null = null;
	let autoLinkPendingFull = false;

	function cancelAutoLinkScan(): void {
		if (autoLinkTimer !== null) {
			clearTimeout(autoLinkTimer);
			autoLinkTimer = null;
		}
		if (autoLinkIdleHandle !== null) {
			const anyWin = window as unknown as {
				cancelIdleCallback?: (h: number) => void;
			};
			anyWin.cancelIdleCallback?.(autoLinkIdleHandle);
			autoLinkIdleHandle = null;
		}
	}

	function runAutoLinkScan(): void {
		const ed = editor;
		if (!ed || ed.isDestroyed) return;
		const meta: { refresh: true; full?: true } = { refresh: true };
		if (autoLinkPendingFull) meta.full = true;
		autoLinkPendingFull = false;
		ed.view.dispatch(ed.state.tr.setMeta(autoLinkPluginKey, meta));
	}

	function scheduleAutoLinkScan(opts?: { full?: boolean }): void {
		if (opts?.full) autoLinkPendingFull = true;
		cancelAutoLinkScan();
		autoLinkTimer = setTimeout(() => {
			autoLinkTimer = null;
			const anyWin = window as unknown as {
				requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
			};
			if (typeof anyWin.requestIdleCallback === "function") {
				autoLinkIdleHandle = anyWin.requestIdleCallback(
					() => {
						autoLinkIdleHandle = null;
						runAutoLinkScan();
					},
					{ timeout: 500 },
				);
			} else {
				runAutoLinkScan();
			}
		}, AUTO_LINK_DEBOUNCE_MS);
	}

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
					codeBlock: false,
					// We substitute extended versions that carry Tomboy round-trip attrs.
					paragraph: false,
					listItem: false,
				}),
				TomboyParagraph,
				TomboyListItem,
				Underline,
				Highlight.configure({ multicolor: false }),
				Placeholder.configure({ placeholder: "Start typing..." }),
				TomboySize,
				TomboyMonospace,
				// TomboyDatetime registered before link extensions so PM ranks
				// it as the outer mark (preserves `<datetime><link>X</link></datetime>`
				// nesting instead of flipping to `<link><datetime>X</datetime></link>`).
				TomboyDatetime,
				TomboyInternalLink.configure({
					onLinkClick: (target: string) => {
						oninternallink?.(target);
					},
					getTitles: () => titleProvider.getTitles(),
					getCurrentGuid: () => currentGuid,
					// Scan only at idle — scheduleAutoLinkScan() below fires
					// a single {refresh:true} after typing pauses. This keeps
					// the keystroke path out of the O(doc * titles) scan.
					deferred: true,
				}),
				TomboyUrlLink,
			],
			content: content ?? {
				type: "doc",
				content: [{ type: "paragraph" }],
			},
			onUpdate: ({ editor: ed }) => {
				// TipTap's onUpdate only fires on docChanged transactions,
				// so the previous JSON.stringify dirty-check was redundant.
				// Auto-link mark mutations appended by the plugin also need
				// to be persisted, so we always forward to onchange and let
				// updateNoteFromEditor's XML-equality check absorb no-ops.
				onchange?.(ed.getJSON());
				scheduleAutoLinkScan();
			},
			editorProps: {
				handleClick: (view, pos, event) => {
					const target = (event.target as HTMLElement).closest(
						"a[data-link-target]",
					);
					if (target) {
						event.preventDefault();
						const linkTarget =
							target.getAttribute("data-link-target");
						if (linkTarget) {
							oninternallink?.(linkTarget);
						}
						return true;
					}
					return false;
				},
			},
		});

		// Note: no initial scan on mount. The note's stored XML already
		// carries the `<link:internal>` marks from its last save, so the
		// deserialized doc shows links immediately. Any staleness (e.g.
		// another note renamed while this one was closed) self-heals on
		// the next edit via the plugin's dirty-range tracking, or
		// immediately via the titleProvider.onChange hook below.

		// When the note list changes (another note created / renamed / deleted),
		// any text in this note might newly match / stop matching a title —
		// ask the plugin for a full-document rescan. Routed through the
		// same debouncer so a burst of cache invalidations collapses into
		// one scan.
		const offChange = titleProvider.onChange(() => {
			scheduleAutoLinkScan({ full: true });
		});

		return () => {
			cancelAutoLinkScan();
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
		padding: 0.5rem;
		font-size: 16px;
		line-height: 1.4;
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
		margin-bottom: 0;
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
