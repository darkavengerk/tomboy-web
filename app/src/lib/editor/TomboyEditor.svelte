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
	import { TomboyPunctuationReplace } from "./extensions/TomboyPunctuationReplace.js";
	import { TomboySubtitlePlaceholder } from "./extensions/TomboySubtitlePlaceholder.js";
	import {
		SlipNoteArrows,
		type SlipNoteArrowsStorage,
	} from "./extensions/SlipNoteArrows.js";
	import {
		DateArrows,
		type DateArrowsStorage,
	} from "./extensions/DateArrows.js";
	import {
		handleClipboardCopy,
		handleClipboardCut,
	} from "./clipboardPlainText.js";
	import { ctrlEnterSplit } from "./ctrlEnterSplit.js";
	import { createTitleProvider } from "./autoLink/titleProvider.js";
	import { autoLinkPluginKey } from "./autoLink/autoLinkPlugin.js";
	import {
		handleTitleBlur,
		isCursorInTitleBlock,
		extractTitleText,
	} from "./titleUniqueGuard.js";
	import { createImagePreviewPlugin } from "./imagePreview/imagePreviewPlugin.js";
	import {
		createSendListItemPlugin,
		sendListItemPluginKey,
	} from "./sendListItem/sendListItemPlugin.js";
	import { transferListItem } from "./sendListItem/transferListItem.js";
	import {
		createAutoWeekdayPlugin,
		autoWeekdayPluginKey,
	} from "./autoWeekday/autoWeekdayPlugin.js";
	import { createTableBlockPlugin } from "./tableBlock/tableBlockPlugin.js";
	import { extractImageFile } from "./imagePreview/extractImageFile.js";
	import { uploadImageToDropbox } from "$lib/sync/imageUpload.js";
	import { pushToast, dismissToast } from "$lib/stores/toast.js";
	import { Extension } from "@tiptap/core";
	import { insertTodayDate } from "./insertDate.js";
	import {
		sinkListItemOnly,
		liftListItemOnly,
		isInList,
	} from "./listItemDepth.js";
	import { moveListItemUp, moveListItemDown } from "./listItemReorder.js";
	import {
		TomboyTodoRegion,
		moveTodoItem,
		insertTodoBlock,
	} from "./todoRegion/index.js";
	import type { JSONContent } from "@tiptap/core";
	import EditorContextMenu from "./EditorContextMenu.svelte";
	import {
		modKeys,
		installModKeyListeners,
	} from "$lib/desktop/modKeys.svelte.js";

	interface Props {
		content?: JSONContent;
		onchange?: (doc: JSONContent) => void;
		oninternallink?: (target: string) => void;
		currentGuid?: string | null;
		enableContextMenu?: boolean;
		/** Tomboy ISO creation date of the current note — used to render the
		 *  "yyyy-mm-dd" placeholder on the empty second line. */
		createDate?: string | null;
		/** When true, each listItem shows a floating "보내기" button that
		 *  transfers it to the configured destination note. */
		sendListItemActive?: boolean;
		/** When true, decorates the 이전/다음 paragraphs with circular arrow
		 *  buttons and hides the original text via CSS. */
		isSlipNote?: boolean;
		/** Called when the user clicks one of the slip-note arrows. `replace`
		 *  is true when Ctrl/Cmd was held — the caller should swap the
		 *  source window for the target instead of cascading. */
		onslipnavigate?: (
			target: string,
			direction: "prev" | "next",
			replace: boolean,
		) => void;
		/** When true, the auto-weekday plugin rewrites day-prefix lines in the
		 *  schedule note. */
		isScheduleNote?: boolean;
		/** Called when the user clicks the slip-note "insert after" (+) button. */
		oninsertafter?: () => void;
		/** Called when the user clicks the slip-note "cut" (✂) button. */
		oncut?: () => void;
		/** Called when the user clicks the slip-note "다른 곳에 연결" (link) button. */
		onconnect?: () => void;
		/** Called when the user clicks the slip-note "paste" button. */
		onpaste?: () => void;
		/** Enables the paste button — typically slipClipboard.hasEntry && entry.guid != current. */
		canPasteSlip?: boolean;
		/** Title of the currently clipboarded slip-note, for the paste button's tooltip. */
		cutSlipTitle?: string | null;
		/** Mode of the clipboard entry: 'cut' changes paste behaviour + tooltip. */
		slipClipboardMode?: "cut" | "connect" | null;
		/** Title of the nearest earlier date-titled note (for the date arrow row). */
		prevDateTitle?: string | null;
		/** Title of the nearest later date-titled note (for the date arrow row). */
		nextDateTitle?: string | null;
		/** Called when the user clicks one of the date-navigation arrows.
		 *  `replace` is true when Ctrl/Cmd was held — the caller should
		 *  swap the source window for the target instead of cascading. */
		ondatenavigate?: (
			target: string,
			direction: "prev" | "next",
			replace: boolean,
		) => void;
	}

	let {
		content,
		onchange,
		oninternallink,
		currentGuid = null,
		enableContextMenu = false,
		createDate = null,
		sendListItemActive = false,
		isSlipNote = false,
		isScheduleNote = false,
		onslipnavigate = () => {},
		oninsertafter = () => {},
		oncut = () => {},
		onconnect = () => {},
		onpaste = () => {},
		canPasteSlip = false,
		cutSlipTitle = null,
		slipClipboardMode = null,
		prevDateTitle = null,
		nextDateTitle = null,
		ondatenavigate = () => {},
	}: Props = $props();

	let ctxMenu = $state<{ x: number; y: number } | null>(null);

	function handleContextMenu(e: MouseEvent) {
		if (!enableContextMenu) return;
		e.preventDefault();
		ctxMenu = { x: e.clientX, y: e.clientY };
	}

	// Closure-bound flag read by the autoWeekday plugin via enabled(). Seeded
	// to false here; the $effect below keeps it in sync with the prop so the
	// plugin always reflects the current isScheduleNote value at call-time.
	let autoWeekdayEnabled = false;

	let editorElement: HTMLDivElement;
	let editor: Editor | null = $state(null);
	// Ctrl/Cmd-held gate for the TODO/Done per-item buttons. Unified with
	// the shared modKeys state so the mobile "Ctrl 고정" toggle and the
	// physical Ctrl/Cmd key both light up the same per-item actions.
	const ctrlHeld = $derived(modKeys.ctrl);

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
		return `${m[1]}-${m[2]}-${m[3]}`;
	}

	function scheduleAutoLinkScan(opts?: { full?: boolean }): void {
		if (opts?.full) autoLinkPendingFull = true;
		cancelAutoLinkScan();
		autoLinkTimer = setTimeout(() => {
			autoLinkTimer = null;
			const anyWin = window as unknown as {
				requestIdleCallback?: (
					cb: () => void,
					opts?: { timeout: number },
				) => number;
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

	// Blur-time title-conflict latch. Prevents the same conflict from
	// re-toasting on every cursor wiggle in/out of the title line; cleared
	// whenever the title text itself changes or the conflict resolves.
	const lastConflictTitleRef: { current: string | null } = { current: null };
	let lastTitleSnapshot = "";
	let prevCursorInTitle: boolean | null = null;

	onMount(() => {
		// Shared Ctrl-held tracker (physical key + mobile Ctrl-lock). The
		// listener module reference-counts installs so DesktopWorkspace and
		// every editor can safely call it in parallel.
		const uninstallModKeys = installModKeyListeners();

		// The current-note filter is applied inside findTitleMatches via the
		// plugin's getCurrentGuid() — the provider returns the full title
		// list so the excluded title can still claim its matched region.
		const titleProvider = createTitleProvider();
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
				TomboyPunctuationReplace,
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
				Extension.create({
					name: "tomboySendListItem",
					addProseMirrorPlugins() {
						return [
							createSendListItemPlugin({
								onSend: (liPos, liNode) => {
									const ed = editor;
									if (!ed) return;
									void transferListItem(ed, liPos, liNode);
								},
							}),
						];
					},
				}),
				Extension.create({
					name: "tomboyAutoWeekday",
					addProseMirrorPlugins() {
						return [
							createAutoWeekdayPlugin({
								now: () => new Date(),
								enabled: () => autoWeekdayEnabled,
							}),
						];
					},
				}),
				Extension.create({
					name: "tomboyTableBlock",
					addProseMirrorPlugins() {
						return [createTableBlockPlugin()];
					},
				}),
				SlipNoteArrows,
				DateArrows,
				TomboyTodoRegion.configure({
					onMove: (liPos, fromKind) => {
						const ed = editor;
						if (!ed || ed.isDestroyed) return;
						moveTodoItem(ed, liPos, fromKind);
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
				// Clear the blur-conflict latch whenever the title text
				// changes — a fresh title deserves a fresh toast on next blur.
				const nowTitle = extractTitleText(ed.state.doc).trim();
				if (nowTitle !== lastTitleSnapshot) {
					lastTitleSnapshot = nowTitle;
					lastConflictTitleRef.current = null;
				}
				scheduleAutoLinkScan();
			},
			editorProps: {
				handleKeyDown: (_view, event) => {
					const ed = editor;
					if (!ed) return false;

					// --- Ctrl/Cmd shortcuts (no Alt, no Shift) ---
					if (
						(event.ctrlKey || event.metaKey) &&
						!event.altKey &&
						!event.shiftKey
					) {
						// Ctrl+Enter: split at end of current line — i.e. keep
						// the line the user is on intact, drop a fresh empty
						// block (paragraph or list item) below, caret lands
						// on it.
						if (event.key === "Enter") {
							event.preventDefault();
							ctrlEnterSplit(ed);
							return true;
						}
						switch (event.key) {
							case "d":
								event.preventDefault();
								insertTodayDate(ed);
								return true;
							case "s":
								event.preventDefault();
								ed.chain().focus().toggleStrike().run();
								return true;
							case "h":
								event.preventDefault();
								ed.chain().focus().toggleHighlight().run();
								return true;
							case "m":
								event.preventDefault();
								ed.chain()
									.focus()
									.toggleTomboyMonospace()
									.run();
								return true;
							case "o":
								event.preventDefault();
								insertTodoBlock(ed);
								return true;
						}
					}

					// --- Alt+Arrow shortcuts (no Ctrl, no Shift) ---
					if (
						event.altKey &&
						!event.ctrlKey &&
						!event.metaKey &&
						!event.shiftKey
					) {
						if (event.key === "ArrowRight") {
							event.preventDefault();
							try {
								const sunk = sinkListItemOnly(ed);
								if (!sunk && !isInList(ed)) {
									ed.chain().focus().toggleBulletList().run();
								}
							} catch (err) {
								console.error(
									"[listItemDepth] operation failed:",
									err,
								);
							}
							return true;
						}
						if (event.key === "ArrowLeft") {
							event.preventDefault();
							try {
								const lifted = liftListItemOnly(ed);
								if (!lifted && isInList(ed)) {
									ed.commands.liftListItem("listItem");
								}
							} catch (err) {
								console.error(
									"[listItemDepth] operation failed:",
									err,
								);
							}
							return true;
						}
						if (event.key === "ArrowUp") {
							event.preventDefault();
							try {
								moveListItemUp(ed);
							} catch (err) {
								console.error(
									"[listItemReorder] operation failed:",
									err,
								);
							}
							return true;
						}
						if (event.key === "ArrowDown") {
							event.preventDefault();
							try {
								moveListItemDown(ed);
							} catch (err) {
								console.error(
									"[listItemReorder] operation failed:",
									err,
								);
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
				// Override PM's default clipboard path so Ctrl+C / Ctrl+X and the
				// browser-level right-click copy/cut menu items all produce
				// Tomboy-style plain text (single \n between blocks, no text/html).
				// The native menu in our context menu also reaches this path when
				// it delegates to document.execCommand('cut') / ('copy').
				handleDOMEvents: {
					copy: handleClipboardCopy,
					cut: handleClipboardCut,
				},
			},
		});

		// Seed the title snapshot so the onUpdate latch-clearing compares
		// against the current title rather than an empty string.
		lastTitleSnapshot = extractTitleText(editor.state.doc).trim();

		// Title uniqueness blur validator. Fires when the cursor transitions
		// OUT of the first block (title line). The editor is reused across
		// note transitions, but so is `prevCursorInTitle` state — the seed
		// `null` means the first selection update only sets the initial
		// in/out flag without firing the validator.
		editor.on("selectionUpdate", ({ editor: ed }) => {
			const { from } = ed.state.selection;
			const nowInTitle = isCursorInTitleBlock(ed.state.doc, from);
			if (prevCursorInTitle === true && nowInTitle === false) {
				void handleTitleBlur(
					ed,
					currentGuid,
					pushToast,
					lastConflictTitleRef,
				);
			}
			prevCursorInTitle = nowInTitle;
		});

		// Seed the slip-note arrow storage with the current props. Subsequent
		// changes are synced via the $effect below.
		const slipStorage = (
			editor.storage as unknown as Record<string, unknown>
		).slipNoteArrows as SlipNoteArrowsStorage;
		slipStorage.enabled = isSlipNote;
		slipStorage.onNavigate = onslipnavigate;
		slipStorage.onInsertAfter = oninsertafter;
		slipStorage.onCut = oncut;
		slipStorage.onConnect = onconnect;
		slipStorage.onPaste = onpaste;
		slipStorage.canPaste = canPasteSlip;
		slipStorage.clipboardTitle = cutSlipTitle;
		slipStorage.clipboardMode = slipClipboardMode;

		// Seed the date-arrow storage. `enabled` is the slip-vs-date
		// segregation gate: slip notes use the slip-note arrows even when
		// their title parses as a date, so we suppress date arrows on
		// notes whose notebook is the Slip-Box. The extension still
		// self-gates on the title matching a date format inside
		// buildDecorations.
		const dateStorage = (
			editor.storage as unknown as Record<string, unknown>
		).dateArrows as DateArrowsStorage;
		dateStorage.enabled = !isSlipNote;
		dateStorage.prevTitle = prevDateTitle;
		dateStorage.nextTitle = nextDateTitle;
		dateStorage.onNavigate = ondatenavigate;

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
			uninstallModKeys();
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
		if (autoWeekdayEnabled) {
			ed.view.dispatch(
				ed.state.tr.setMeta(autoWeekdayPluginKey, { rescan: true }),
			);
		}
		// Any pending scan timer was for the previous note; drop it.
		cancelAutoLinkScan();
	});

	// Toggle the "send list item" plugin's active flag whenever the parent's
	// prop changes. Dispatched as a meta transaction so PM re-runs the
	// decorations prop and mounts / unmounts the per-li buttons.
	$effect(() => {
		const active = sendListItemActive;
		const ed = editor;
		if (!ed || ed.isDestroyed) return;
		const current = sendListItemPluginKey.getState(ed.state);
		if (current?.active === active) return;
		ed.view.dispatch(
			ed.state.tr.setMeta(sendListItemPluginKey, { active }),
		);
	});

	// Sync slip-note arrow props to the extension storage and force the
	// decorations plugin to recompute. Dispatching a no-op transaction is
	// the cheapest way to re-run `props.decorations` without mutating the
	// document.
	$effect(() => {
		const flag = isSlipNote;
		const navigate = onslipnavigate;
		const insertAfter = oninsertafter;
		const cut = oncut;
		const connect = onconnect;
		const paste = onpaste;
		const canPaste = canPasteSlip;
		const clipboardTitle = cutSlipTitle;
		const clipboardMode = slipClipboardMode;
		const ed = editor;
		if (!ed || ed.isDestroyed) return;
		const storage = (ed.storage as unknown as Record<string, unknown>)
			.slipNoteArrows as SlipNoteArrowsStorage;
		const changed =
			storage.enabled !== flag ||
			storage.onNavigate !== navigate ||
			storage.onInsertAfter !== insertAfter ||
			storage.onCut !== cut ||
			storage.onConnect !== connect ||
			storage.onPaste !== paste ||
			storage.canPaste !== canPaste ||
			storage.clipboardTitle !== clipboardTitle ||
			storage.clipboardMode !== clipboardMode;
		if (!changed) return;
		storage.enabled = flag;
		storage.onNavigate = navigate;
		storage.onInsertAfter = insertAfter;
		storage.onCut = cut;
		storage.onConnect = connect;
		storage.onPaste = paste;
		storage.canPaste = canPaste;
		storage.clipboardTitle = clipboardTitle;
		storage.clipboardMode = clipboardMode;
		ed.view.dispatch(ed.state.tr);
	});

	// Sync date-arrow props to the extension storage. The decorations plugin
	// re-runs on doc changes automatically (title-format gate); we only need
	// to force a rebuild when prev/next targets, the navigate handler, or
	// the slip-vs-date gate (`enabled`) change while the doc is unchanged.
	$effect(() => {
		const prev = prevDateTitle;
		const next = nextDateTitle;
		const navigate = ondatenavigate;
		const enabled = !isSlipNote;
		const ed = editor;
		if (!ed || ed.isDestroyed) return;
		const storage = (ed.storage as unknown as Record<string, unknown>)
			.dateArrows as DateArrowsStorage;
		const changed =
			storage.enabled !== enabled ||
			storage.prevTitle !== prev ||
			storage.nextTitle !== next ||
			storage.onNavigate !== navigate;
		if (!changed) return;
		storage.enabled = enabled;
		storage.prevTitle = prev;
		storage.nextTitle = next;
		storage.onNavigate = navigate;
		ed.view.dispatch(ed.state.tr);
	});

	// Keep the closure-bound autoWeekday flag in sync with the prop. When the
	// flag flips from false→true (async resolution of getScheduleNoteGuid after
	// setContent has already fired), dispatch a rescan so pre-existing malformed
	// entries are fixed immediately without requiring a user keystroke.
	$effect(() => {
		const wasEnabled = autoWeekdayEnabled;
		autoWeekdayEnabled = isScheduleNote;
		if (!wasEnabled && isScheduleNote) {
			const ed = editor;
			if (ed && !ed.isDestroyed) {
				ed.view.dispatch(
					ed.state.tr.setMeta(autoWeekdayPluginKey, { rescan: true }),
				);
			}
		}
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
					marks: [{ type: "tomboyUrlLink", attrs: { href: url } }],
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
<div
	bind:this={editorElement}
	class="tomboy-editor"
	class:tomboy-todo-ctrl-hold={ctrlHeld}
	oncontextmenu={handleContextMenu}
></div>

{#if ctxMenu && editor}
	<EditorContextMenu
		{editor}
		x={ctxMenu.x}
		y={ctxMenu.y}
		onclose={() => (ctxMenu = null)}
		{oninternallink}
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
		margin-bottom: -0.4em;
	}

	/* Second paragraph (body top) = subtitle slot: smaller, muted */
	.tomboy-editor :global(.tiptap > p:nth-child(2)) {
		font-size: 0.8em;
		line-height: 2.4;
		color: #666;
		vertical-align: top;
		padding-left: 0.1em;
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

	/* "보내기" mode: bigger bullets so the user sees the mode is active,
	   and room on the right for the floating button. */
	.tomboy-editor :global(.tomboy-send-active li) {
		position: relative;
		padding-right: 4.2em;
		list-style: none;
	}
	.tomboy-editor :global(.tomboy-send-active li::before) {
		content: "•";
		position: absolute;
		left: -1em;
		top: 0;
		color: #3465a4;
		font-size: 1.4em;
		line-height: 1;
	}
	.tomboy-editor :global(.tomboy-send-li-btn) {
		position: absolute;
		right: 0;
		top: 0;
		padding: 2px 8px;
		font-size: 0.75rem;
		line-height: 1.3;
		background: #3465a4;
		color: #fff;
		border: none;
		border-radius: 3px;
		cursor: pointer;
		user-select: none;
	}
	.tomboy-editor :global(.tomboy-send-li-btn:hover) {
		background: #204a87;
	}

	/* Slip-note prev/next row. Both arrows ride on block 2's line; the
	   original `이전:` / `다음:` text stays in the doc but is hidden via
	   font-size:0 + color:transparent, and block 3 is collapsed entirely.
	   No extra vertical space — the paragraph's height is just the button
	   height. */
	.tomboy-editor :global(p.slipnote-combined-line) {
		display: flex;
		align-items: center;
		margin: 0;
		font-size: 0;
		color: transparent;
		line-height: 0;
	}
	.tomboy-editor :global(p.slipnote-combined-line a),
	.tomboy-editor :global(p.slipnote-combined-line br) {
		display: none;
	}
	.tomboy-editor :global(p.slipnote-hidden-line) {
		display: none;
	}
	.tomboy-editor :global(.slipnote-arrow) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 34px;
		height: 34px;
		padding: 0;
		border: none;
		border-radius: 50%;
		background: rgba(0, 0, 0, 0.06);
		color: #333;
		font-size: 1rem;
		line-height: 1;
		cursor: pointer;
		vertical-align: middle;
	}
	.tomboy-editor :global(.slipnote-arrow-next) {
		margin-left: auto;
	}
	.tomboy-editor :global(.slipnote-arrow:disabled) {
		opacity: 0.3;
		cursor: default;
		background: transparent;
	}
	.tomboy-editor :global(.slipnote-arrow:not(:disabled):hover) {
		background: rgba(0, 0, 0, 0.12);
	}
	.tomboy-editor :global(.slipnote-arrow:not(:disabled):active) {
		background: rgba(0, 0, 0, 0.18);
	}

	/* Chain-edit action cluster, sitting between the prev/next arrows. The
	   wrapper centers itself in the flex row via auto side-margins, so the
	   prev arrow stays flush left and next stays flush right (next keeps
	   its own margin-left:auto for safety when the cluster is missing). */
	.tomboy-editor :global(.slipnote-actions) {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		margin: 0 auto;
	}
	.tomboy-editor :global(.slipnote-action) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		padding: 0;
		border: none;
		border-radius: 50%;
		background: rgba(0, 0, 0, 0.04);
		color: #555;
		cursor: pointer;
	}
	.tomboy-editor :global(.slipnote-action:disabled) {
		opacity: 0.25;
		cursor: default;
		background: transparent;
	}
	.tomboy-editor :global(.slipnote-action:not(:disabled):hover) {
		background: rgba(0, 0, 0, 0.1);
		color: #222;
	}
	.tomboy-editor :global(.slipnote-action:not(:disabled):active) {
		background: rgba(0, 0, 0, 0.16);
	}

	/* Date-title prev/next arrow row. Rendered as a block-level widget
	   decoration between block 0 (title) and block 1, so it sits on its
	   own line directly under the title. Not part of the persisted doc. */
	.tomboy-editor :global(.datelink-arrow-row) {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin: 0;
		padding: 0;
		user-select: none;
	}
	.tomboy-editor :global(.datelink-arrow) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 34px;
		height: 34px;
		padding: 0;
		border: none;
		border-radius: 50%;
		background: rgba(0, 0, 0, 0.06);
		color: #333;
		line-height: 1;
		cursor: pointer;
	}
	.tomboy-editor :global(.datelink-arrow:disabled) {
		opacity: 0.3;
		cursor: default;
		background: transparent;
	}
	.tomboy-editor :global(.datelink-arrow:not(:disabled):hover) {
		background: rgba(0, 0, 0, 0.12);
	}
	.tomboy-editor :global(.datelink-arrow:not(:disabled):active) {
		background: rgba(0, 0, 0, 0.18);
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
		color: #909090;
		content: attr(data-placeholder);
		float: left;
		height: 0;
		pointer-events: none;
		font-size: 0.8em;
	}

	/* TODO / Done region per-item buttons. The button is rendered as a
	   widget decoration inside each `<li>` in a region; visibility is
	   gated by (a) Ctrl/Cmd held on the window, reflected as the
	   .tomboy-todo-ctrl-hold class on .tomboy-editor, AND (b) the li being
	   hovered. Invisible and non-interactive otherwise so casual mouse
	   movement can't trigger a completion. */
	.tomboy-editor :global(li.tomboy-todo-item) {
		position: relative;
		border-radius: 3px;
		transition: background-color 0.1s;
	}
	/* Wide notes make it easy to lose track of which row a button belongs
	   to. While a row is hover-targeted (Ctrl held + cursor over the li),
	   tint the row so the move target is unambiguous. The tint scope
	   matches the move scope: depth-1 hover tints the whole category
	   (including its nested children), depth-2 hover tints just that row. */
	.tomboy-editor.tomboy-todo-ctrl-hold
		:global(li.tomboy-todo-item:has(> .tomboy-todo-complete-btn):hover) {
		background-color: rgba(46, 125, 50, 0.1);
	}
	.tomboy-editor.tomboy-todo-ctrl-hold
		:global(li.tomboy-todo-item:has(> .tomboy-todo-revert-btn):hover) {
		background-color: rgba(117, 117, 117, 0.15);
	}
	/* When a depth-2 child is hovered, the parent depth-1's tint and
	   button are both suppressed (button rule below). Override the parent
	   highlight here for parity. */
	.tomboy-editor.tomboy-todo-ctrl-hold
		:global(li.tomboy-todo-item:has(li.tomboy-todo-item:hover)) {
		background-color: transparent;
	}
	.tomboy-editor :global(.tomboy-todo-complete-btn),
	.tomboy-editor :global(.tomboy-todo-revert-btn) {
		position: absolute;
		right: 0;
		top: 0;
		padding: 2px 8px;
		font-size: 0.75rem;
		line-height: 1.3;
		border: none;
		border-radius: 3px;
		cursor: pointer;
		user-select: none;
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.1s;
		z-index: 1;
	}
	.tomboy-editor :global(.tomboy-todo-complete-btn) {
		background: #2e7d32;
		color: #fff;
	}
	.tomboy-editor :global(.tomboy-todo-complete-btn:hover) {
		background: #1b5e20;
	}
	.tomboy-editor :global(.tomboy-todo-revert-btn) {
		background: #757575;
		color: #fff;
	}
	.tomboy-editor :global(.tomboy-todo-revert-btn:hover) {
		background: #555;
	}
	.tomboy-editor.tomboy-todo-ctrl-hold
		:global(li.tomboy-todo-item:hover .tomboy-todo-complete-btn),
	.tomboy-editor.tomboy-todo-ctrl-hold
		:global(li.tomboy-todo-item:hover .tomboy-todo-revert-btn) {
		opacity: 1;
		pointer-events: auto;
	}
	/* When a depth-1 category contains the hovered depth-2 item, suppress
	   its own button so only the deepest hovered item's button shows.
	   Otherwise hovering a sub-item would surface BOTH buttons (the
	   category one and the item one) at the same vertical area. */
	.tomboy-editor.tomboy-todo-ctrl-hold
		:global(
			li.tomboy-todo-item:has(li.tomboy-todo-item:hover)
				> .tomboy-todo-complete-btn
		),
	.tomboy-editor.tomboy-todo-ctrl-hold
		:global(
			li.tomboy-todo-item:has(li.tomboy-todo-item:hover)
				> .tomboy-todo-revert-btn
		) {
		opacity: 0;
		pointer-events: none;
	}

	/* Touch devices have no reliable :hover, so when the mobile Ctrl-lock
	   is on, reveal the TODO / 되돌리기 buttons for every item without
	   requiring a hover. */
	@media (hover: none), (pointer: coarse) {
		.tomboy-editor.tomboy-todo-ctrl-hold
			:global(li.tomboy-todo-item .tomboy-todo-complete-btn),
		.tomboy-editor.tomboy-todo-ctrl-hold
			:global(li.tomboy-todo-item .tomboy-todo-revert-btn) {
			opacity: 1;
			pointer-events: auto;
		}
	}

	/* CSV/TSV table block.

	   Checked (default): inline+node hide decorations zero out the source
	   paragraphs and a block-level widget renders the table in their place.
	   The toggle checkbox is absolutely positioned at the widget's top
	   right and stays at opacity:0 until the widget is :hover'd.

	   Unchecked: no hide decos, source visible. A small inline-block
	   widget lives INSIDE the open-fence paragraph, floated to the right
	   of the line; it too is opacity:0 until the user hovers the
	   paragraph or the widget itself. */
	.tomboy-editor :global(.tomboy-table-block-hidden) {
		display: none;
	}
	.tomboy-editor :global(p.tomboy-table-block-hidden-block) {
		margin: 0;
		padding: 0;
		height: 0;
		overflow: hidden;
	}
	.tomboy-editor :global(.tomboy-table-block-widget) {
		position: relative;
		display: block;
		margin: 0.6em 0;
		padding: 0.4em;
		border: 1px solid #d0d7de;
		border-radius: 6px;
		background: #f6f8fa;
		user-select: none;
	}
	.tomboy-editor :global(.tomboy-table-block-toggle) {
		position: absolute;
		top: 6px;
		right: 8px;
		display: inline-flex;
		align-items: center;
		padding: 2px 4px;
		border-radius: 3px;
		background: rgba(255, 255, 255, 0.85);
		opacity: 0;
		transition: opacity 0.12s;
		cursor: pointer;
		z-index: 1;
	}
	.tomboy-editor :global(.tomboy-table-block-widget:hover .tomboy-table-block-toggle) {
		opacity: 1;
	}
	.tomboy-editor :global(.tomboy-table-block-toggle input) {
		cursor: pointer;
	}
	/* Floating toggle for the unchecked state — sits inside the source
	   paragraph and floats right. Hover-revealed: appears on either the
	   surrounding paragraph hover (so the user can find it from anywhere
	   on the line) or on direct hover of the widget. */
	.tomboy-editor :global(.tomboy-table-block-floating) {
		float: right;
		display: inline-flex;
		align-items: center;
		margin-left: 0.4em;
		padding: 0 4px;
		border-radius: 3px;
		background: rgba(0, 0, 0, 0.04);
		opacity: 0;
		transition: opacity 0.12s;
		cursor: pointer;
		user-select: none;
	}
	.tomboy-editor :global(p:hover > .tomboy-table-block-floating),
	.tomboy-editor :global(.tomboy-table-block-floating:hover) {
		opacity: 1;
	}
	.tomboy-editor :global(.tomboy-table-block-floating input) {
		cursor: pointer;
	}
	.tomboy-editor :global(.tomboy-table-block-table) {
		border-collapse: collapse;
		width: 100%;
		background: #fff;
		font-size: 0.95em;
	}
	.tomboy-editor :global(.tomboy-table-block-table th),
	.tomboy-editor :global(.tomboy-table-block-table td) {
		border: 1px solid #d0d7de;
		padding: 0.3em 0.6em;
		text-align: left;
		vertical-align: top;
	}
	.tomboy-editor :global(.tomboy-table-block-table th) {
		background: #eaeef2;
		font-weight: 600;
	}
	.tomboy-editor :global(.tomboy-table-block-empty) {
		color: #888;
		font-style: italic;
	}
</style>
