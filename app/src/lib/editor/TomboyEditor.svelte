<script lang="ts">
	import { onMount } from "svelte";
	import { Editor } from "@tiptap/core";
	import StarterKit from "@tiptap/starter-kit";
	import Highlight from "@tiptap/extension-highlight";
	import Placeholder from "@tiptap/extension-placeholder";
	import { TomboySize } from "./extensions/TomboySize.js";
	import { TomboyMonospace } from "./extensions/TomboyMonospace.js";
	import { TomboyInternalLink } from "./extensions/TomboyInternalLink.js";
	import { TomboyUrlLink } from "./extensions/TomboyUrlLink.js";
	import { TomboyDatetime } from "./extensions/TomboyDatetime.js";
	import { TomboyListItem } from "./extensions/TomboyListItem.js";
	import { TomboyParagraph } from "./extensions/TomboyParagraph.js";
	import { TomboySubtitlePlaceholder } from "./extensions/TomboySubtitlePlaceholder.js";
	import { createTitleProvider } from "./autoLink/titleProvider.js";
	import { autoLinkPluginKey } from "./autoLink/autoLinkPlugin.js";
	import { createImagePreviewPlugin } from "./imagePreview/imagePreviewPlugin.js";
	import { extractImageFile } from "./imagePreview/extractImageFile.js";
	import { uploadImageToDropbox } from "$lib/sync/imageUpload.js";
	import { pushToast, dismissToast } from "$lib/stores/toast.js";
	import { Extension } from "@tiptap/core";
	import { insertTodayDate } from "./insertDate.js";
	import { sinkListItemOnly, liftListItemOnly, isInList } from "./listItemDepth.js";
	import { moveListItemUp, moveListItemDown } from "./listItemReorder.js";
	import type { JSONContent } from "@tiptap/core";
	import EditorContextMenu from "./EditorContextMenu.svelte";

	interface Props {
		content?: JSONContent;
		onchange?: (doc: JSONContent) => void;
		oninternallink?: (target: string) => void;
		currentGuid?: string | null;
		enableContextMenu?: boolean;
		/** Tomboy ISO creation date of the current note — used to render the
		 *  "yyyy-mm-dd 생성됨" placeholder on the empty second line. */
		createDate?: string | null;
	}

	let {
		content,
		onchange,
		oninternallink,
		currentGuid = null,
		enableContextMenu = false,
		createDate = null,
	}: Props = $props();

	let ctxMenu = $state<{ x: number; y: number } | null>(null);

	function handleContextMenu(e: MouseEvent) {
		if (!enableContextMenu) return;
		e.preventDefault();
		ctxMenu = { x: e.clientX, y: e.clientY };
	}

	let editorElement: HTMLDivElement;
	let editor: Editor | null = $state(null);

	// Track the last content/guid we pushed into the editor. The $effect
	// below only swaps the editor's doc when the parent actually navigates
	// to a different note — not on every reactive pass where `content` is
	// re-read but unchanged. Left undefined/null until the first $effect
	// run after mount seeds them, so we don't accidentally capture stale
	// initial prop values at component-construction time.
	let lastAppliedContent: JSONContent | undefined = undefined;
	let lastAppliedGuid: string | null = null;
	let contentSyncSeeded = false;

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

	// Format a Tomboy ISO date (yyyy-MM-ddTHH:mm:ss.fffffff±HH:MM) as
	// yyyy-mm-dd for the subtitle placeholder. Returns null for missing /
	// unparseable inputs so the placeholder is simply skipped.
	function subtitlePlaceholderText(): string | null {
		if (!createDate) return null;
		const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(createDate);
		if (!m) return null;
		return `${m[1]}-${m[2]}-${m[3]} 생성됨`;
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
		// Use a dynamic excludeGuid callback so the provider follows note
		// transitions without needing dispose + recreate. The editor
		// instance is reused across notes (see $effect below), and the
		// plugin also reads getCurrentGuid() on every scan, so the filter
		// stays correct for the active note.
		const titleProvider = createTitleProvider({
			getExcludeGuid: () => currentGuid,
		});
		// Populate titles asynchronously; the plugin reads via getTitles() so
		// late arrivals still auto-link pre-existing content via the refresh meta.
		// refresh() is a fast-path no-op when sharedEntries is already warm
		// (common case: a workspace that already has other editors open), so
		// this doesn't trigger a redundant listNotes() IDB read on every
		// new window.
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
				// Underline is bundled by StarterKit v3 — importing it again
				// produces a "Duplicate extension names" warning.
				Highlight.configure({ multicolor: false }),
				Placeholder.configure({ placeholder: "Start typing..." }),
				TomboySubtitlePlaceholder.configure({
					getPlaceholderText: subtitlePlaceholderText,
				}),
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
				Extension.create({
					name: "tomboyImagePreview",
					addProseMirrorPlugins() {
						return [createImagePreviewPlugin()];
					},
				}),
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
				handleKeyDown: (_view, event) => {
					const ed = editor;
					if (!ed) return false;

					// --- Ctrl/Cmd shortcuts (no Alt, no Shift) ---
					if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
						switch (event.key) {
							case 'd':
								event.preventDefault();
								insertTodayDate(ed);
								return true;
							case 's':
								event.preventDefault();
								ed.chain().focus().toggleStrike().run();
								return true;
							case 'h':
								event.preventDefault();
								ed.chain().focus().toggleHighlight().run();
								return true;
							case 'm':
								event.preventDefault();
								ed.chain().focus().toggleTomboyMonospace().run();
								return true;
							case 'l':
								event.preventDefault();
								ed.chain().focus().toggleBulletList().run();
								return true;
						}
					}

					// --- Alt+Arrow shortcuts (no Ctrl, no Shift) ---
					if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
						if (event.key === 'ArrowRight') {
							event.preventDefault();
							try {
								const sunk = sinkListItemOnly(ed);
								if (!sunk && !isInList(ed)) {
									ed.chain().focus().toggleBulletList().run();
								}
							} catch (err) {
								console.error('[listItemDepth] operation failed:', err);
							}
							return true;
						}
						if (event.key === 'ArrowLeft') {
							event.preventDefault();
							try {
								const lifted = liftListItemOnly(ed);
								if (!lifted && isInList(ed)) {
									ed.commands.liftListItem('listItem');
								}
							} catch (err) {
								console.error('[listItemDepth] operation failed:', err);
							}
							return true;
						}
						if (event.key === 'ArrowUp') {
							event.preventDefault();
							try {
								moveListItemUp(ed);
							} catch (err) {
								console.error('[listItemReorder] operation failed:', err);
							}
							return true;
						}
						if (event.key === 'ArrowDown') {
							event.preventDefault();
							try {
								moveListItemDown(ed);
							} catch (err) {
								console.error('[listItemReorder] operation failed:', err);
							}
							return true;
						}
					}

					return false;
				},
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
				handlePaste: (_view, event) => {
					const file = extractImageFile(event.clipboardData);
					if (!file) return false;
					event.preventDefault();
					void uploadAndInsertImage(file);
					return true;
				},
				handleDrop: (_view, event) => {
					const file = extractImageFile(event.dataTransfer);
					if (!file) return false;
					event.preventDefault();
					void uploadAndInsertImage(file);
					return true;
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

	// Reactively swap the editor's document when the parent navigates to a
	// different note (or otherwise hands us new content). Reusing the same
	// TipTap instance across notes avoids the full
	// destroy→PM-schema-rebuild→extension-init→DOM-mount churn that the
	// previous `{#key noteId}` pattern paid on every transition.
	$effect(() => {
		const c = content;
		const g = currentGuid;
		const ed = editor;
		if (!ed || ed.isDestroyed) return;

		if (!contentSyncSeeded) {
			// First run after onMount created the editor: the editor was
			// initialised with the current `content` already, so just
			// record the applied state — no setContent, no clearDirty.
			contentSyncSeeded = true;
			lastAppliedContent = c;
			lastAppliedGuid = g;
			return;
		}

		if (c === lastAppliedContent && g === lastAppliedGuid) return;
		lastAppliedContent = c;
		lastAppliedGuid = g;

		const docContent = c ?? {
			type: "doc",
			content: [{ type: "paragraph" }],
		};
		// emitUpdate:false so the parent's onchange doesn't interpret this
		// as a user edit (no spurious save triggered for just loading a
		// note). The plugin still sees the underlying PM transaction and
		// would otherwise accumulate the whole new doc as a dirty range,
		// so we clear that explicitly below — the stored XML already
		// carries `<link:internal>` marks and a rescan on load is neither
		// needed nor cheap for large notes.
		ed.commands.setContent(docContent, { emitUpdate: false });
		ed.view.dispatch(
			ed.state.tr.setMeta(autoLinkPluginKey, {
				clearDirty: true,
				skip: true,
			}),
		);
		// Any pending scan timer was for the previous note; drop it.
		cancelAutoLinkScan();
	});

	export function getEditor(): Editor | null {
		return editor;
	}

	/**
	 * Upload an image file to Dropbox and insert the resulting direct URL
	 * at the current cursor position, wrapped in a tomboyUrlLink mark so
	 * the note's XML round-trip treats it as a `<link:url>` anchor. The
	 * image-preview plugin then renders the actual image in place of the
	 * URL text — see imagePreviewPlugin.ts.
	 */
	export async function uploadAndInsertImage(file: File): Promise<void> {
		const ed = editor;
		if (!ed) return;

		const toastId = pushToast("이미지 업로드 중…", { timeoutMs: 0 });
		try {
			const url = await uploadImageToDropbox(file);
			dismissToast(toastId);
			// Save the selection at the moment we insert. If the user moved
			// the cursor while the upload was in flight, insert at the
			// current cursor anyway — matches the mental model of "the
			// image goes where I am now", and avoids stale position bugs.
			ed.chain()
				.focus()
				.insertContent({
					type: "text",
					text: url,
					marks: [
						{ type: "tomboyUrlLink", attrs: { href: url } },
					],
				})
				.run();
			pushToast("이미지 업로드 완료");
		} catch (err) {
			dismissToast(toastId);
			const msg = err instanceof Error ? err.message : String(err);
			pushToast(`이미지 업로드 실패: ${msg}`, { kind: "error" });
		}
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div bind:this={editorElement} class="tomboy-editor" oncontextmenu={handleContextMenu}></div>

{#if ctxMenu && editor}
	<EditorContextMenu
		editor={editor}
		x={ctxMenu.x}
		y={ctxMenu.y}
		onclose={() => (ctxMenu = null)}
		oninternallink={oninternallink}
	/>
{/if}

<style>
	.tomboy-editor {
		flex: 1;
		overflow-y: auto;
		padding: 0.5rem;
		font-size: 16px;
		line-height: 1.4;
		/* NOTE: we deliberately do NOT set `container-type: size` here.
		   That would imply `contain: size`, which prevents the element
		   from being sized by its contents. It works on the desktop
		   NoteWindow (where .body is a flex column giving .tomboy-editor
		   a definite height via flex:1), but collapses the editor to 0
		   on the mobile /note/[id] page where .editor-area is a plain
		   block scroller — .tomboy-editor there is content-sized, so
		   size containment zeroes it out and the note appears blank.
		   Instead, the outer scroll container in each consumer sets
		   `container-type: size` (see .editor-area and .body). Image
		   previews reference that container via `100cqh` below. */
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

	/* Second paragraph (body top) = subtitle slot: smaller, muted */
	.tomboy-editor :global(.tiptap > p:nth-child(2)) {
		font-size: 0.85em;
		line-height: 1.25;
		color: #666;
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

	/* Inline image preview widget (decoration; not part of the doc). The
	   underlying text (including any <link:url> mark) is preserved verbatim
	   for round-trip compatibility with Tomboy desktop.

	   Sizing: default to the image's natural size, but cap to the note's
	   visible width (max-width: 100%) and height (max-height: 100cqh, the
	   size-container set on .tomboy-editor). Aspect ratio is preserved. */
	.tomboy-editor :global(img.tomboy-image-preview) {
		display: block;
		max-width: 100%;
		max-height: 100cqh;
		width: auto;
		height: auto;
		margin: 0.4em 0;
		border-radius: 4px;
		background: rgba(0, 0, 0, 0.04);
		cursor: pointer;
	}

	/* Image-URL text is hidden so the image alone represents the link.
	   Delete / ArrowLeft / ArrowRight are intercepted in the plugin so the
	   hidden URL behaves atomically — i.e. Backspace at the end of the URL
	   removes the whole URL, arrow keys skip across it. */
	.tomboy-editor :global(.tomboy-image-url-hidden) {
		display: none;
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

	/* Subtitle (second line) creation-date placeholder. Applied only when
	   the second paragraph is empty and the cursor is not on it — see
	   TomboySubtitlePlaceholder. */
	.tomboy-editor :global(.tiptap p.tomboy-subtitle-placeholder::before) {
		color: #adb5bd;
		content: attr(data-placeholder);
		float: left;
		height: 0;
		pointer-events: none;
	}
</style>
