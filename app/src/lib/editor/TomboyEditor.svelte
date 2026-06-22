<script lang="ts">
	import { onMount } from "svelte";
	import { Editor } from "@tiptap/core";
	import {
		installCursorVisibility,
		shouldDeferScrollToSelection,
	} from "./keepCursorVisible.js";
	import { cursorDebug } from "$lib/stores/cursorDebug.svelte.js";
	import { applyCommandModeKeyboard } from "./commandModeKeyboard.js";
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
	import { ClipboardFidelity } from "./clipboardFidelity.js";
	import { ctrlEnterSplit } from "./ctrlEnterSplit.js";
	import { createTitleProvider } from "./autoLink/titleProvider.js";
	import { shouldRescanForDelta } from "./autoLink/shouldRescanForDelta.js";
	import { consumeNewNoteIntent } from "$lib/core/newNoteIntent.js";
	import { autoLinkPluginKey } from "./autoLink/autoLinkPlugin.js";
	import {
		handleTitleBlur,
		isCursorInTitleBlock,
		extractTitleText,
	} from "./titleUniqueGuard.js";
	import { createImagePreviewPlugin } from "./imagePreview/imagePreviewPlugin.js";
	import { createGeoMapPlugin } from "./geoMap/geoMapPlugin.js";
import { createTitleIsolationPlugin } from "./titleIsolation/titleIsolationPlugin.js";
import { createChartBlockPlugin } from "./chartBlock/chartBlockPlugin.js";
import { createAutomationNotePlugin } from "./automationNote/automationNotePlugin.js";
import { createHueNotePlugin } from "./hueNote/hueNotePlugin.js";
import { createRemarkableNotePlugin } from "./remarkableNote/remarkableNotePlugin.js";
import { createNoteTitleDropPlugin } from "./noteTitleDrop/noteTitleDropPlugin.js";
import { TomboyMusicNote } from "./musicNote/index.js";
import { TomboyMusicExtractNote } from "./musicExtractNote/index.js";
import { TomboySunoImport } from "./sunoNote/index.js";
import { TomboyBridgeNote } from "./bridgeNote/index.js";
import { createMusicControlHidePlugin } from "./musicControlNote/musicControlHidePlugin.js";
import { MUSIC_CONTROL_GUID } from "$lib/music/musicControlNote.js";
	import {
		createSendListItemPlugin,
		sendListItemPluginKey,
	} from "./sendListItem/sendListItemPlugin.js";
	import {
		transferListItem,
		skipListItem,
	} from "./sendListItem/transferListItem.js";
	import {
		createAutoWeekdayPlugin,
		autoWeekdayPluginKey,
	} from "./autoWeekday/autoWeekdayPlugin.js";
	import { createChatNotePlugin } from "./chatNote/chatNotePlugin.js";
	import { CLAUDE_HEADER_DEFAULTS } from "$lib/chatNote/defaults.js";
	import {
		getClaudeDefaultSystem,
		getClaudeDefaultModel,
		getClaudeDefaultEffort,
	} from "$lib/storage/appSettings.js";
	import { createThinkingDisplayPlugin } from "./chatNote/thinkingDisplayPlugin.js";
	import {
		createTableBlockPlugin,
		setCtrlHeld as setTableBlockCtrlHeld,
	} from "./tableBlock/tableBlockPlugin.js";
	import {
		createHrSplitPlugin,
		hrSplitPluginKey,
	} from "./hrSplit/hrSplitPlugin.js";
	import {
		createHrFoldPlugin,
		hrFoldPluginKey,
	} from "./hrSplit/hrFoldPlugin.js";
	import {
		createEqHeaderPlugin,
		eqHeaderPluginKey,
	} from "./eqHeader/eqHeaderPlugin.js";
	import StickyHeader from "./eqHeader/StickyHeader.svelte";
	import { createLabeledDividerPlugin } from "./labeledDivider/labeledDividerPlugin.js";
	import {
		createLabeledFoldPlugin,
		labeledFoldPluginKey,
	} from "./labeledDivider/labeledFoldPlugin.js";
	import {
		loadFocusedOrdinals,
		saveFocusedOrdinals,
	} from "./labeledDivider/labeledFoldStore.js";
	import { restoreSelectionClamped } from "$lib/editor/restoreSelection.js";
	import {
		loadActiveOrdinals,
		saveActiveOrdinals,
		loadColumnWidths,
		saveColumnWidths,
	} from "./hrSplit/hrSplitStore.js";
	import {
		loadFoldedOrdinals,
		saveFoldedOrdinals,
	} from "./hrSplit/hrFoldStore.js";
	import { extractImageFile } from "./imagePreview/extractImageFile.js";
	import { extractAnyFile } from "./extractFile.js";
	import { uploadTempImage } from "$lib/sync/tempImageUpload.js";
	import {
		uploadBridgeFile,
		BridgeFileUploadError,
	} from "$lib/sync/bridgeFileUpload.js";
	import { pushToast, dismissToast } from "$lib/stores/toast.js";
	import { Extension } from "@tiptap/core";
	import { insertTodayDate } from "./insertDate.js";
	import { insertTable } from "./insertTable.js";
	import { deleteCurrentLine } from "./deleteLine.js";
	import { insertTabAtCursor } from "./insertTab.js";
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
	import {
		TomboyProcessRegion,
		moveProcessItem,
		insertProcessBlock,
	} from "./processRegion/index.js";
	import {
		TomboyChecklist,
		toggleCheckboxAt,
		insertChecklistBlock,
	} from "./checklist/index.js";
	import { FootnoteMarker, TomboyFootnoteExtension } from "./footnote/index.js";
	import { createFootnoteClaudePlugin } from "./footnote/claudePlugin.js";
	import { TomboyInlineCheckbox, insertInlineCheckbox } from './inlineCheckbox';
	import { TomboyInlineRadio, insertInlineRadio } from './inlineRadio';
	import { TomboyListBox, toggleRadioAt } from './listBox/index.js';
	import { TomboyBlockquote } from "./blockquote/index.js";
	import { createFindPlugin, findPluginKey } from "./find/findPlugin.js";
	import FindBar from "./find/FindBar.svelte";
	import { unfocusedCaretPlugin } from "./unfocusedCaret/unfocusedCaretPlugin.js";
	import type { JSONContent } from "@tiptap/core";
	import EditorContextMenu from "./EditorContextMenu.svelte";
	import {
		modKeys,
		installModKeyListeners,
	} from "$lib/desktop/modKeys.svelte.js";
	import { mount as mountSvelte, unmount as unmountSvelte } from "svelte";
	import TomboyEditorSelf from "./TomboyEditor.svelte"; // 셀프 임포트 — 임베디드 에디터 주입용
	import NoteBundleStack from "./noteBundle/NoteBundleStack.svelte";
	import NoteBundleCabinet from "./noteBundle/NoteBundleCabinet.svelte";
	import { createNoteBundlePlugin } from "./noteBundle/noteBundlePlugin.js";
	import type { BundleSpec } from "./noteBundle/parser.js";
	import { dedicatedBundleKind } from "./noteBundle/parser.js";

	interface Props {
		content?: JSONContent;
		onchange?: (doc: JSONContent) => void;
		/** Fired when the editor loses focus — hosts flush pending edits here so
		 *  leaving an editor commits it before another view of the same note saves. */
		onblur?: () => void;
		oninternallink?: (target: string) => void;
		currentGuid?: string | null;
		enableContextMenu?: boolean;
		/** 컨텍스트 메뉴에 "리마커블로 보내기" 항목을 보이게 한다. 부모가 핸들러를
		 *  넘기지 않으면 항목 자체가 사라진다 — 데스크탑 노트 윈도우만 켠다. */
		onsendremarkable?: () => void;
		/** Tomboy ISO creation date of the current note — used to render the
		 *  "yyyy-mm-dd" placeholder on the empty second line. */
		createDate?: string | null;
		/** Slip-note category label (text before the chain HEAD's link in
		 *  the slip-box index). Takes precedence over the create-date
		 *  placeholder for slip notes — for non-slip notes, leave null. */
		slipNoteLabel?: string | null;
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
		/** Enables the Ctrl+click `---` → multi-column split feature.
		 *  Defaults to true (desktop). The mobile route should set false
		 *  — small screens can't usefully show side-by-side columns and
		 *  the hover cue would just confuse touch users. */
		hrSplitEnabled?: boolean;
		/** Fired when the user toggles a `---` divider on/off. Carries the
		 *  new and previous active counts so the host (desktop NoteWindow)
		 *  can resize the window so each column keeps roughly the original
		 *  note width. Not fired on note load or pruning. */
		onhrsplitchange?: (newCount: number, prevCount: number) => void;
		/** Whether THIS note is the currently focused window (desktop) /
		 *  the visible note (mobile). Defaults to true so single-note
		 *  routes don't need to thread it. Gates table-block ctrl-mode
		 *  so a Ctrl press doesn't activate edit chrome on every open
		 *  note simultaneously. */
		noteFocused?: boolean;
		/** Fired AFTER an image has been successfully uploaded to Dropbox AND
		 *  the resulting URL has been inserted into the editor. Carries both
		 *  the inserted Dropbox URL and the ORIGINAL File. The File lets
		 *  downstream consumers (e.g. OCR for ocr:// notes) read the bytes
		 *  without re-fetching the URL — Dropbox shared links block CORS
		 *  `fetch()` even though `<img src>` works. */
		onimageinserted?: (url: string, file: File) => void;
		/** Keep the caret scrolled clear of a floating bottom toolbar while
		 *  typing. Surfaces that overlay such a toolbar opt in; others leave it
		 *  false and keep the browser's native scroll behaviour. */
		keepCursorVisible?: boolean;
		/** Scroll model for `keepCursorVisible`. "window" (mobile /note/[id]):
		 *  body scroll + fixed toolbar (`--toolbar-height`). "container"
		 *  (desktop NoteWindow): the editor's own overflow parent + the 30px
		 *  `--toolbar-h` strip. */
		cursorVisibilityMode?: "window" | "container";
		/** 노트 묶음 스택 렌더 여부. 임베디드(번들 안) 에디터는 false 로
		 *  중첩 번들을 막는다 (depth 1 — 번들 안 번들은 리스트로만 보임). */
		enableNoteBundle?: boolean;
		/** 첫 top-level 줄(타이틀)을 에디터에서 숨기고 커서/Backspace 를 가드.
		 *  실제 노트 편집 화면(/note, NoteWindow)만 true. 번들 임베디드는 false. */
		hideTitleLine?: boolean;
		/** 콘텐츠 스왑(setContent)이 settle 된 뒤 1회 호출. 생성 로딩 플로우가
		 *  '에디터 여는 중' 단계를 종료하는 신호로 쓴다. */
		onnoteready?: (guid: string | null) => void;
		/** 읽기 전용 렌더(히스토리 창). editable=false + autolink 스캔 skip. 기본 false. */
		readOnly?: boolean;
		/** 음악 노트 재생 origin 노트 guid — 묶음 임베디드 에디터가 자신의 호스트
		 *  guid 를 넘긴다. 레일 곡 제목 클릭 시 이 노트를 연다("재생을 누른 화면"으로
		 *  복귀). 일반 노트는 null 이라 origin 이 노트 자신으로 폴백. */
		musicOriginGuid?: string | null;
	}

	let {
		content,
		onchange,
		onblur,
		oninternallink,
		currentGuid = null,
		enableContextMenu = false,
		createDate = null,
		slipNoteLabel = null,
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
		hrSplitEnabled = true,
		onhrsplitchange,
		noteFocused = true,
		onimageinserted = () => {},
		keepCursorVisible = false,
		cursorVisibilityMode = "window",
		onsendremarkable,
		enableNoteBundle = true,
		hideTitleLine = false,
		onnoteready = () => {},
		readOnly = false,
		musicOriginGuid = null,
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
	// Claude chat-note defaults, read by createChatNotePlugin via a closure so
	// 설정 changes apply to new notes without re-creating the editor. Seeded to
	// the hardcoded fallback; loaded from appSettings in onMount.
	let claudeDefSystem: string = CLAUDE_HEADER_DEFAULTS.system;
	let claudeDefModel: string = CLAUDE_HEADER_DEFAULTS.model;
	let claudeDefEffort: string = CLAUDE_HEADER_DEFAULTS.effort;
	// Same trick for the hrSplit plugin's enabled gate and change emitter.
	// The plugin reads `hrSplitEnabledFlag` and calls `hrSplitChangeFn` via
	// closures so prop changes take effect without re-creating extensions.
	// Seeded to safe defaults; the $effect below syncs from the props.
	let hrSplitEnabledFlag = true;
	// titleIsolation enabled 게이트 — prop 을 클로저로 읽어 재생성 없이 반영.
	let hideTitleLineFlag = false;
	let hrSplitChangeFn:
		| ((newCount: number, prevCount: number) => void)
		| undefined = undefined;

	// `$state` (not a plain `let`) because it's read reactively in the template
	// — passed to <StickyHeader> as `editorEl`. bind:this assigns it once at
	// mount; declaring it $state keeps svelte-check happy about that read.
	let editorElement = $state<HTMLDivElement>()!;
	let editor: Editor | null = $state(null);
	// `===` 고정 헤더: 경계(top-level 인덱스)와 doc 버전. eqHeaderPlugin 의
	// onChange 가 갱신하고 StickyHeader 가 소비한다.
	let eqBoundary = $state<number | null>(null);
	let eqVersion = $state(0);
	// --- In-note find ("Ctrl/Cmd+F") state ---
	// findOpen drives the FindBar; findQuery is the controlled input value;
	// findCount / findActiveIndex mirror the find plugin's state on every
	// transaction so the bar can render "3 / 12".
	let findOpen = $state(false);
	let findQuery = $state("");
	let findCount = $state(0);
	let findActiveIndex = $state(-1);
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

	// Subtitle placeholder text for the empty second line. Dedicated filing
	// notes (`탭::`/`묶음::`) use that line as an options slot, so they show the
	// `:높이:개수` syntax hint instead of a date. Slip notes show their chain's
	// category label (resolved by the parent and passed via `slipNoteLabel`);
	// regular notes show the creation date. Returns null when none apply, so
	// the placeholder is simply skipped.
	function subtitlePlaceholderText(): string | null {
		const title = editor?.state.doc.firstChild?.textContent ?? "";
		if (dedicatedBundleKind(title)) return ":높이:개수  예) :50:10";
		if (isSlipNote) return slipNoteLabel ?? null;
		if (!createDate) return null;
		const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(createDate);
		if (!m) return null;
		return `${m[1]}-${m[2]}-${m[3]}`;
	}

	function scheduleAutoLinkScan(opts?: { full?: boolean }): void {
		if (readOnly) return;
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

		void getClaudeDefaultSystem().then((v) => (claudeDefSystem = v));
		void getClaudeDefaultModel().then((v) => (claudeDefModel = v));
		void getClaudeDefaultEffort().then((v) => (claudeDefEffort = v));

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
			editable: !readOnly,
			extensions: [
				StarterKit.configure({
					// Disable code (we use tomboyMonospace instead)
					code: false,
					codeBlock: false,
					// We substitute extended versions that carry Tomboy round-trip attrs.
					paragraph: false,
					listItem: false,
					// Disable the `---` → <hr> input rule. Tomboy's .note XML
					// has no HR element, so an HR PM node would silently
					// vanish on save. We instead treat top-level paragraphs
					// whose trimmed text is `---` (3+ dashes) as virtual HRs
					// — they round-trip through the XML serializer as plain
					// paragraphs and our hrSplit plugin renders them as
					// horizontal lines via decoration.
					horizontalRule: false,
					// Same story for blockquote: its `> ` input rule would
					// eat the typed text and wrap the paragraph in a PM
					// blockquote node the archiver can't serialize (silent
					// data loss on save) — and our TomboyBlockquote plugin
					// renders `> `-prefixed paragraphs via decoration, which
					// the input rule would preempt before it ever matched.
					blockquote: false,
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
					name: "tomboyUnfocusedCaret",
					addProseMirrorPlugins() {
						return [unfocusedCaretPlugin()];
					},
				}),
				Extension.create({
					name: "tomboyGeoMap",
					addProseMirrorPlugins() {
						return [createGeoMapPlugin()];
					},
				}),
				Extension.create({
					name: "tomboyTitleIsolation",
					addProseMirrorPlugins() {
						return [createTitleIsolationPlugin(() => hideTitleLineFlag)];
					},
				}),
				Extension.create({
					name: "tomboyNoteBundle",
					addProseMirrorPlugins() {
						if (!enableNoteBundle) return [];
						return [
							createNoteBundlePlugin({
								mountStack: (container, view, spec) => {
									// $state 프록시 props — 이후 spec 갱신이
									// 리마운트 없이 컴포넌트에 반영된다.
									const props = $state({
										spec,
										view,
										hostGuid: currentGuid,
										EditorComponent: TomboyEditorSelf,
										oninternallink: (t: string) =>
											oninternallink?.(t),
									});
									// kind 별 컴포넌트: '탭:' = 재귀 탭(NoteBundleStack),
									// '묶음:' = 5칸 윈도우 서류함(NoteBundleCabinet).
									// kind 변경 시 플러그인이 destroy 후 리마운트하므로
									// 마운트 시점의 spec.kind 가 컴포넌트를 고정한다.
									const Comp =
										spec.kind === "bundle"
											? NoteBundleCabinet
											: NoteBundleStack;
									const inst = mountSvelte(Comp, {
										target: container,
										props,
									});
									return {
										update(s: BundleSpec) {
											props.spec = s;
											props.hostGuid = currentGuid;
										},
										destroy() {
											void unmountSvelte(inst);
										},
									};
								},
							}),
						];
					},
				}),
				Extension.create({
					name: "tomboyChartBlock",
					addProseMirrorPlugins() {
						return [createChartBlockPlugin()];
					},
				}),
				Extension.create({
					name: "tomboyAutomationNote",
					addProseMirrorPlugins() {
						return [createAutomationNotePlugin()];
					},
				}),
				Extension.create({
					name: "tomboyHueNote",
					addProseMirrorPlugins() {
						return [
							createHueNotePlugin({
								getGuid: () => currentGuid ?? "",
								oninternallink: (t) => oninternallink?.(t),
							}),
						];
					},
				}),
				Extension.create({
					name: "tomboyRemarkableNote",
					addProseMirrorPlugins() {
						return [createRemarkableNotePlugin()];
					},
				}),
				Extension.create({
					name: "tomboyNoteTitleDrop",
					addProseMirrorPlugins() {
						return [createNoteTitleDropPlugin()];
					},
				}),
				TomboyMusicNote.configure({
					getGuid: () => currentGuid ?? "",
					getOrigin: () => musicOriginGuid ?? null,
				}),
				TomboyMusicExtractNote.configure({
					oninternallink: (t: string) => oninternallink?.(t),
				}),
				TomboySunoImport,
				TomboyBridgeNote,
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
								onSkip: (liPos, liNode) => {
									const ed = editor;
									if (!ed) return;
									skipListItem(ed, liPos, liNode);
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
					name: "tomboyMusicControlHide",
					addProseMirrorPlugins() {
						return [
							createMusicControlHidePlugin({
								enabled: () => currentGuid === MUSIC_CONTROL_GUID,
							}),
						];
					},
				}),
				Extension.create({
					name: "tomboyLlmNote",
					addProseMirrorPlugins() {
						return [
							createChatNotePlugin({
								claudeDefaults: () => ({
									system: claudeDefSystem,
									model: claudeDefModel,
									effort: claudeDefEffort,
								}),
							}),
						];
					},
				}),
				Extension.create({
					name: "tomboyThinkingDisplay",
					addProseMirrorPlugins() {
						return [createThinkingDisplayPlugin()];
					},
				}),
				Extension.create({
					name: "tomboyFootnoteClaude",
					addProseMirrorPlugins() {
						return [createFootnoteClaudePlugin()];
					},
				}),
				Extension.create({
					name: "tomboyTableBlock",
					addProseMirrorPlugins() {
						return [createTableBlockPlugin()];
					},
				}),
				Extension.create({
					name: "tomboyHrSplit",
					addProseMirrorPlugins() {
						return [
							createHrSplitPlugin({
								enabled: () => hrSplitEnabledFlag,
								onChange: (active, widths, prev) => {
									// Persist whichever guid is currently bound
									// to the editor. Closure-read via the
									// `lastAppliedGuid` tracker so re-keying on
									// note swap is automatic.
									saveActiveOrdinals(lastAppliedGuid, active);
									saveColumnWidths(lastAppliedGuid, widths);
									if (active.size !== prev.size) {
										hrSplitChangeFn?.(
											active.size,
											prev.size,
										);
									}
								},
							}),
						];
					},
				}),
				Extension.create({
					name: "tomboyEqHeader",
					addProseMirrorPlugins() {
						return [
							createEqHeaderPlugin({
								onChange: (boundary, version) => {
									eqBoundary = boundary;
									eqVersion = version;
								},
							}),
						];
					},
				}),
				Extension.create({
					name: "tomboyHrFold",
					addProseMirrorPlugins() {
						return [
							createHrFoldPlugin({
								onChange: (folded) => {
									// Same closure trick as hrSplit: persist under
									// whichever guid is currently bound to the editor.
									saveFoldedOrdinals(lastAppliedGuid, folded);
								},
							}),
						];
					},
				}),
				Extension.create({
					name: "tomboyLabeledDivider",
					addProseMirrorPlugins() {
						return [createLabeledDividerPlugin()];
					},
				}),
				Extension.create({
					name: "tomboyLabeledFold",
					addProseMirrorPlugins() {
						return [
							createLabeledFoldPlugin({
								onChange: (focused) => {
									saveFocusedOrdinals(lastAppliedGuid, focused);
								},
							}),
						];
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
				TomboyProcessRegion.configure({
					onMove: (liPos, direction) => {
						const ed = editor;
						if (!ed || ed.isDestroyed) return;
						moveProcessItem(ed, liPos, direction);
					},
					// depth-3 체크박스 항목 토글 — 체크리스트와 같은 attr 토글 재사용.
					onToggleCheck: (liPos) => {
						const ed = editor;
						if (!ed || ed.isDestroyed) return;
						toggleCheckboxAt(ed, liPos);
					},
				}),
				TomboyChecklist.configure({
					onToggle: (liPos) => {
						const ed = editor;
						if (!ed || ed.isDestroyed) return;
						toggleCheckboxAt(ed, liPos);
					},
				}),
				TomboyListBox.configure({
					onToggleCheck: (liPos) => {
						const ed = editor;
						if (!ed || ed.isDestroyed) return;
						toggleCheckboxAt(ed, liPos);
					},
					onToggleRadio: (liPos) => {
						const ed = editor;
						if (!ed || ed.isDestroyed) return;
						toggleRadioAt(ed, liPos);
					},
				}),
				FootnoteMarker,
				TomboyFootnoteExtension.configure({
					onMissing: (label, kind) => {
						pushToast(
							kind === "reference"
								? `각주 '${label}' 설명을 찾을 수 없습니다`
								: `각주 '${label}' 참조를 찾을 수 없습니다`,
							{ kind: "error" },
						);
					},
				}),
				...TomboyInlineCheckbox,
				...TomboyInlineRadio,
				TomboyBlockquote,
				// 노트→노트 붙여넣기 원본 보존(data-tomboy-slice 복원) +
				// plain 붙여넣기 빈 줄 보존. 복사 쪽 짝은 아래
				// handleDOMEvents.copy/cut 의 clipboardPlainText.ts.
				ClipboardFidelity,
				Extension.create({
					name: "tomboyFind",
					addProseMirrorPlugins() {
						return [createFindPlugin()];
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
			onBlur: () => {
				onblur?.();
			},
			editorProps: {
				// Downward caret reveals are owned by installCursorVisibility()
				// (it knows the live --toolbar-height and the true visual-viewport
				// bottom incl. offsetTop). The old static scrollMargin/Threshold
				// {bottom:60} double-corrected against it whenever the toolbar
				// height drifted from 60, and PM scrolls on EVERY mobile virtual-
				// keyboard keystroke (readDOMChange always sets scrollIntoView)
				// with a window rect that ignores vv.offsetTop — phantom scrolls
				// on iOS. Upward reveals / range selections / unfocused views
				// stay with PM (returning false keeps its default behaviour).
				...(keepCursorVisible
					? {
							handleScrollToSelection: (view: Editor["view"]) => {
								// Debug (mobile/window only): with PM-scroll-defer off,
								// return false so ProseMirror runs its own native
								// scrollToSelection. Desktop container mode ignores the flag.
								if (
									cursorVisibilityMode === "window" &&
									!cursorDebug.pmScrollDefer
								)
									return false;
								return shouldDeferScrollToSelection(view, cursorVisibilityMode);
							},
						}
					: {}),
				handleKeyDown: (_view, event) => {
					const ed = editor;
					if (!ed) return false;

					// --- Tab → insert literal "\t" outside lists ---
					// Browsers treat Tab in contenteditable as "move focus to
					// next focusable element," which yanks focus out of the
					// note. Override so notes behave like a regular text
					// editor. Inside a list, defer to TipTap's sinkListItem
					// keymap (and the surgical Alt+Arrow variants) so list
					// indent still works.
					if (
						event.key === "Tab" &&
						!event.ctrlKey &&
						!event.metaKey &&
						!event.altKey &&
						!event.shiftKey
					) {
						if (insertTabAtCursor(ed)) {
							event.preventDefault();
							return true;
						}
						return false;
					}

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
							case "f":
								event.preventDefault();
								openFind();
								return true;
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
							case "p":
								event.preventDefault();
								insertChecklistBlock(ed);
								return true;
							case "k":
								event.preventDefault();
								deleteCurrentLine(ed);
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
						// Alt+글자 조합은 event.code (물리 키) 로 판별 —
						// event.key 는 macOS Option 특수문자(∆/π/®/ç),
						// 한글 IME 자모, CapsLock 대문자에 따라 달라진다.
						// 각주 삽입.
						if (event.code === "KeyJ") {
							event.preventDefault();
							ed.chain().focus().insertFootnote().run();
							return true;
						}
						// 프로세스(멀티스테이지 칸반) 블록 삽입.
						if (event.code === "KeyP") {
							event.preventDefault();
							insertProcessBlock(ed);
							return true;
						}
						// 인라인 라디오 ( ) 삽입.
						if (event.code === "KeyR") {
							event.preventDefault();
							insertInlineRadio(ed);
							return true;
						}
						// 인라인 체크박스 [ ] 삽입.
						if (event.code === "KeyC") {
							event.preventDefault();
							insertInlineCheckbox(ed);
							return true;
						}
						// 빈 마크다운 표 삽입.
						if (event.code === "KeyT") {
							event.preventDefault();
							insertTable(ed);
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
					const img = extractImageFile(event.clipboardData);
					if (img) {
						event.preventDefault();
						void uploadAndInsertImage(img);
						return true;
					}
					const any = extractAnyFile(event.clipboardData);
					if (any && !any.isImage) {
						event.preventDefault();
						void uploadAndInsertFile(any.file);
						return true;
					}
					return false;
				},
				handleDrop: (_view, event) => {
					const img = extractImageFile(event.dataTransfer);
					if (img) {
						event.preventDefault();
						void uploadAndInsertImage(img);
						return true;
					}
					const any = extractAnyFile(event.dataTransfer);
					if (any && !any.isImage) {
						event.preventDefault();
						void uploadAndInsertFile(any.file);
						return true;
					}
					return false;
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

		// Seed `===` boundary/version from the freshly-created plugin state so a
		// note that already contains `===` shows the sticky header immediately,
		// regardless of view()/onChange ordering.
		{
			const eqState = eqHeaderPluginKey.getState(editor.state);
			if (eqState) {
				eqBoundary = eqState.boundary;
				eqVersion = eqState.version;
			}
		}

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

		// Mirror the find plugin's match count + active index into Svelte
		// state on every transaction, so the FindBar can render "3 / 12".
		editor.on("transaction", ({ editor: ed }) => {
			const fs = findPluginKey.getState(ed.state);
			if (!fs) return;
			findCount = fs.matches.length;
			findActiveIndex = fs.activeIndex;
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
		const offChange = titleProvider.onChange((delta) => {
			const ed = editor;
			if (!ed || ed.isDestroyed) { scheduleAutoLinkScan({ full: true }); return; }
			if (shouldRescanForDelta(delta, ed.state.doc.textContent)) {
				scheduleAutoLinkScan({ full: true });
			}
		});

		// Keep the caret above the floating bottom toolbar while typing (mobile
		// note route + desktop NoteWindow opt in). No-op unless the mode's
		// toolbar var (--toolbar-height / --toolbar-h) is set.
		const uninstallCursorVisibility = keepCursorVisible
			? installCursorVisibility(editor, {
					mode: cursorVisibilityMode,
					// Debug (mobile/window only): jsCursorNudge gates the scrollBy.
					// Desktop container mode always runs — its overflow scroller
					// ignores scroll-padding, so the JS nudge is the only thing
					// keeping the caret above the toolbar.
					enabled: () =>
						cursorVisibilityMode === "container" || cursorDebug.jsCursorNudge,
				})
			: () => {};

		return () => {
			uninstallCursorVisibility();
			uninstallModKeys();
			cancelAutoLinkScan();
			offChange();
			titleProvider.dispose();
			editor?.destroy();
		};
	});

	// Mobile "명령 모드": while a Ctrl/Alt lock toggle is on, tapping the note to
	// position the caret must not raise the keyboard (the user is about to fire a
	// shortcut button, not type). See applyCommandModeKeyboard for the rationale.
	// Reads only runes + mutates the DOM — no $state write, so no update loop.
	$effect(() => {
		const locked = modKeys.ctrlLocked || modKeys.altLocked;
		const view = editor?.view;
		if (!view || view.isDestroyed) return;
		applyCommandModeKeyboard(view, locked);
	});

	// When a note was just *created* (not reopened), place the cursor for the
	// user: select the auto-generated date title whole so one keystroke
	// replaces it, or — for a note created with an explicit title — drop the
	// cursor at the start of line 3 (the line after the line-2 placeholder) so
	// they start writing the body. Consumed once per guid; reopened notes have
	// no intent and keep the editor's default "no auto-focus" behaviour.
	function applyNewNoteIntent(ed: Editor, guid: string | null): void {
		if (!guid) return;
		const intent = consumeNewNoteIntent(guid);
		if (!intent) return;
		// Defer until after the PM view has settled from setContent — moving
		// the selection + focusing in the same tick races the DOM update on
		// mobile (the keyboard pops before layout settles).
		requestAnimationFrame(() => {
			if (ed.isDestroyed) return;
			const doc = ed.state.doc;
			if (intent === "selectTitle") {
				const first = doc.firstChild;
				if (!first) return;
				ed.chain()
					.focus()
					.setTextSelection({ from: 1, to: 1 + first.content.size })
					.run();
				return;
			}
			// bodyCursor: start of the 3rd top-level block. Fall back to the
			// end of the doc if the note has fewer than 3 blocks.
			if (doc.childCount >= 3) {
				let pos = 0;
				for (let i = 0; i < 2; i++) pos += doc.child(i).nodeSize;
				ed.chain().focus().setTextSelection(pos + 1).run();
			} else {
				ed.chain().focus("end").run();
			}
		});
	}

	// Signal "note ready" only AFTER the browser has painted the setContent
	// result. A SINGLE requestAnimationFrame fires BEFORE that paint, so
	// newNoteFlow stage 2 (which races this signal via markEditorReady) closed
	// its progress popup one frame early — while the editor's first paint +
	// plugin decoration pass was still pending. That gap was the "popup gone
	// but still janky" the user saw. The double rAF waits one full paint, so
	// the signal now means painted+interactive. It also lands AFTER
	// applyNewNoteIntent's own (earlier, single) caret/focus rAF, folding the
	// mobile keyboard-pop reflow inside the popup window too.
	function signalNoteReadyAfterPaint(ed: Editor, guid: string | null): void {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				if (!ed.isDestroyed) onnoteready(guid);
			});
		});
	}

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
			// Seed HR split + fold state from localStorage for the initial note.
			{
				const persistedWidths = loadColumnWidths(g);
				ed.view.dispatch(
					ed.state.tr.setMeta(hrSplitPluginKey, {
						replace: Array.from(loadActiveOrdinals(g)),
						...(persistedWidths ? { widths: persistedWidths } : {}),
					}),
				);
				ed.view.dispatch(
					ed.state.tr.setMeta(hrFoldPluginKey, {
						replace: Array.from(loadFoldedOrdinals(g)),
					}),
				);
				ed.view.dispatch(
					ed.state.tr.setMeta(labeledFoldPluginKey, {
						replace: Array.from(loadFocusedOrdinals(g)),
					}),
				);
			}
			applyNewNoteIntent(ed, g);
			signalNoteReadyAfterPaint(ed, g);
			return;
		}

		if (c === lastAppliedContent && g === lastAppliedGuid) return;
		// Same guid + new content = a sibling-save reload of THIS note. Preserve
		// the caret across the swap; a different guid is a navigation, where the
		// new-note intent positions the caret instead.
		const sameNoteReload = g === lastAppliedGuid;
		const savedSel =
			sameNoteReload && !ed.isDestroyed
				? { from: ed.state.selection.from, to: ed.state.selection.to }
				: null;
		lastAppliedContent = c;
		lastAppliedGuid = g;

		const docContent = c ?? {
			type: "doc",
			content: [{ type: "paragraph" }],
		};
		// Reseed HR split + fold state for the freshly loaded note BEFORE
		// swapping the doc. If we did it after, setContent's docChanged
		// reconciliation would prune the OLD note's active ordinals against
		// the NEW doc and then persist that mangled set under the new guid's
		// storage key.
		{
			const persistedWidths = loadColumnWidths(g);
			ed.view.dispatch(
				ed.state.tr.setMeta(hrSplitPluginKey, {
					replace: Array.from(loadActiveOrdinals(g)),
					...(persistedWidths ? { widths: persistedWidths } : {}),
				}),
			);
			ed.view.dispatch(
				ed.state.tr.setMeta(hrFoldPluginKey, {
					replace: Array.from(loadFoldedOrdinals(g)),
				}),
			);
			ed.view.dispatch(
				ed.state.tr.setMeta(labeledFoldPluginKey, {
					replace: Array.from(loadFocusedOrdinals(g)),
				}),
			);
		}
		// emitUpdate:false so the parent's onchange doesn't interpret this
		// as a user edit (no spurious save triggered for just loading a
		// note). The plugin still sees the underlying PM transaction and
		// would otherwise accumulate the whole new doc as a dirty range,
		// so we clear that explicitly below — the stored XML already
		// carries `<link:internal>` marks and a rescan on load is neither
		// needed nor cheap for large notes.
		ed.commands.setContent(docContent, { emitUpdate: false });
		if (savedSel) {
			const tr = restoreSelectionClamped(ed.state, savedSel);
			if (tr) ed.view.dispatch(tr);
		}
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

		// Close the find bar — find is scoped to a single note.
		if (findOpen) {
			findOpen = false;
			ed.view.dispatch(
				ed.state.tr.setMeta(findPluginKey, { close: true }),
			);
		}
		findQuery = "";

		applyNewNoteIntent(ed, g);
		signalNoteReadyAfterPaint(ed, g);
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

	// Keep the closure-bound hrSplit flags in sync with the props. When the
	// enabled flag flips, force a no-op transaction so the plugin's
	// decorations / attributes props re-run with the new value (otherwise
	// a mobile-route switch wouldn't immediately drop the split layout).
	$effect(() => {
		const enabled = hrSplitEnabled;
		const cb = onhrsplitchange;
		const enabledChanged = enabled !== hrSplitEnabledFlag;
		hrSplitEnabledFlag = enabled;
		hrSplitChangeFn = cb;
		if (enabledChanged) {
			const ed = editor;
			if (ed && !ed.isDestroyed) {
				ed.view.dispatch(ed.state.tr);
			}
		}
	});

	$effect(() => {
		hideTitleLineFlag = hideTitleLine;
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

	// Re-render the subtitle placeholder when the resolved slip-note label
	// arrives. The placeholder is read from a closure inside the plugin's
	// decorations pass, so a no-op transaction is enough to force a fresh
	// pass without mutating the doc.
	$effect(() => {
		void slipNoteLabel;
		void isSlipNote;
		const ed = editor;
		if (!ed || ed.isDestroyed) return;
		ed.view.dispatch(ed.state.tr);
	});

	// Drive the table-block plugin's ctrl-mode chrome (X / + buttons on
	// the rendered table) from the shared modKeys.ctrl rune so physical
	// Ctrl AND the mobile Ctrl-lock both light up the editing UI. Gated
	// by `noteFocused`: a Ctrl press shouldn't activate table chrome on
	// every open note window simultaneously — only the focused one.
	$effect(() => {
		const held = ctrlHeld && noteFocused;
		const ed = editor;
		if (!ed || ed.isDestroyed) return;
		setTableBlockCtrlHeld(ed, held);
	});

	/**
	 * Open the in-note find bar. If the current selection is non-empty and
	 * lies within a single textblock, its text prefills the query;
	 * otherwise the last query (if any) is re-applied. Exposed so the
	 * Toolbar's 찾기 button can open find on mobile.
	 */
	export function openFind(): void {
		const ed = editor;
		if (!ed || ed.isDestroyed) return;
		findOpen = true;
		const { from, to, empty } = ed.state.selection;
		let prefill: string | null = null;
		if (!empty) {
			const resolvedFrom = ed.state.doc.resolve(from);
			const resolvedTo = ed.state.doc.resolve(to);
			if (
				resolvedFrom.sameParent(resolvedTo) &&
				resolvedFrom.parent.isTextblock
			) {
				prefill = ed.state.doc.textBetween(from, to);
			}
		}
		const q = prefill ? prefill : findQuery;
		findQuery = q;
		ed.view.dispatch(ed.state.tr.setMeta(findPluginKey, { query: q }));
	}

	function handleFindQuery(q: string): void {
		const ed = editor;
		if (!ed || ed.isDestroyed) return;
		findQuery = q;
		ed.view.dispatch(ed.state.tr.setMeta(findPluginKey, { query: q }));
	}

	function handleFindNav(direction: "next" | "prev"): void {
		const ed = editor;
		if (!ed || ed.isDestroyed) return;
		ed.view.dispatch(
			ed.state.tr.setMeta(findPluginKey, { nav: direction }),
		);
	}

	function closeFind(): void {
		findOpen = false;
		const ed = editor;
		if (!ed || ed.isDestroyed) return;
		ed.view.dispatch(ed.state.tr.setMeta(findPluginKey, { close: true }));
		ed.commands.focus();
	}

	export function getEditor(): Editor | null {
		return editor;
	}

	/**
	 * Upload an image file to Vercel Blob (임시 저장소) and insert the
	 * resulting direct URL at the current cursor position, wrapped in a
	 * tomboyUrlLink mark so the note's XML round-trip treats it as a
	 * `<link:url>` anchor. The image-preview plugin then renders the actual
	 * image in place of the URL text — see imagePreviewPlugin.ts.
	 * (Permanent promotion to Dropbox is handled separately by imagePromotion.)
	 */
	export async function uploadAndInsertImage(file: File): Promise<void> {
		const ed = editor;
		if (!ed) return;

		const toastId = pushToast("이미지 업로드 중…", { timeoutMs: 0 });
		try {
			const url = await uploadTempImage(file);
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
			onimageinserted(url, file);
		} catch (err) {
			dismissToast(toastId);
			const msg = err instanceof Error ? err.message : String(err);
			pushToast(`이미지 업로드 실패: ${msg}`, { kind: "error" });
		}
	}

	/**
	 * Upload a non-image file to the bridge and insert the resulting
	 * download URL at the current cursor position. Wraps URL text in a
	 * tomboyUrlLink mark so the `.note` XML round-trip writes `<link:url>`
	 * (same path images take). The URL is shown verbatim as a plain
	 * clickable link — copyable and pasteable into 음악:: notes.
	 */
	export async function uploadAndInsertFile(file: File): Promise<void> {
		const ed = editor;
		if (!ed) return;

		const toastId = pushToast(`${file.name} 업로드 중…`, { timeoutMs: 0 });
		try {
			const result = await uploadBridgeFile(file);
			dismissToast(toastId);
			ed.chain()
				.focus()
				.insertContent({
					type: "text",
					text: result.url,
					marks: [
						{ type: "tomboyUrlLink", attrs: { href: result.url } },
					],
				})
				.run();
			pushToast(`${result.filename} 업로드 완료`);
		} catch (err) {
			dismissToast(toastId);
			const msg =
				err instanceof BridgeFileUploadError
					? err.message
					: err instanceof Error
						? err.message
						: String(err);
			pushToast(`파일 업로드 실패: ${msg}`, { kind: "error" });
		}
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="tomboy-editor-shell">
	{#if findOpen}
		<div class="find-bar-slot">
			<FindBar
				query={findQuery}
				count={findCount}
				activeIndex={findActiveIndex}
				onquery={handleFindQuery}
				onnext={() => handleFindNav("next")}
				onprev={() => handleFindNav("prev")}
				onclose={closeFind}
			/>
		</div>
	{/if}
	<div
		bind:this={editorElement}
		class="tomboy-editor"
		class:tomboy-todo-ctrl-hold={ctrlHeld}
		oncontextmenu={handleContextMenu}
	></div>
	<StickyHeader
		{editor}
		editorEl={editorElement}
		boundaryIndex={eqBoundary}
		version={eqVersion}
	/>
</div>

{#if ctxMenu && editor}
	<EditorContextMenu
		{editor}
		x={ctxMenu.x}
		y={ctxMenu.y}
		onclose={() => (ctxMenu = null)}
		{oninternallink}
		onuploadfile={uploadAndInsertFile}
		{onsendremarkable}
	/>
{/if}

<style>
	.tomboy-editor-shell {
		position: relative;
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	/* Find bar floats at the editor's top-right. The shell does not scroll
	   (the inner .tomboy-editor does), so the bar stays pinned. */
	.find-bar-slot {
		position: absolute;
		top: 6px;
		right: 6px;
		z-index: 10;
	}

	.tomboy-editor {
		flex: 1;
		min-height: 0;
		/* body 가 scrollable 이라 내부 스크롤 없이 컨텐츠 만큼 늘어남.
		   overflow-y:auto / -webkit-overflow-scrolling 제거. */
		padding: 0.5rem;
		font-size: 16px;
		line-height: 1.4;
	}

	/* blur 상태에서도 caret / selection 위치를 시각적으로 유지. 모바일
	   에서 키보드 dismiss 후 "어디를 편집/선택 중이었는지" 잃지 않도록.
	   blink 안 함: /desktop 다중 창에서 비활성 창마다 무한 opacity
	   애니메이션이 돌면 firefox 가 inline 요소를 compositor layer 로
	   승격 못 해 에디터 영역을 매 프레임 main-thread repaint → idle CPU
	   폭증. 정적 표시로 충분(위치만 알려주면 됨). */
	.tomboy-editor :global(.unfocused-caret) {
		display: inline-block;
		width: 1px;
		height: 1.1em;
		background: currentColor;
		vertical-align: text-bottom;
		margin-bottom: -0.05em;
		pointer-events: none;
		opacity: 0.7;
	}

	/* 가짜 selection — iOS Safari 의 native selection 색에 가까운 옅은
	   파랑. blink 없이 안정적으로 표시. */
	.tomboy-editor :global(.unfocused-selection) {
		background-color: rgba(100, 150, 255, 0.35);
	}

	.tomboy-editor :global(.tiptap) {
		outline: none;
		min-height: 100%;
		/* Tab keystroke inserts a literal "\t" — render it at 4 chars wide
		   so the indent looks like a normal text editor rather than the
		   browser default of 8. */
		tab-size: 4;
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

	/* Second paragraph (body top) = subtitle slot: smaller, muted. The title
	   (first line) is hidden in the note editor, so this date/label line sits at
	   the very top — keep it tight to the body below (the old tall line-height
	   left a wasted gap above line 3).
	   Suppressed for `::` notes — the tomboySubtitlePlaceholder plugin tags the
	   root with `.tomboy-no-subtitle` (see subtitleSlot.ts). */
	.tomboy-editor :global(.tiptap:not(.tomboy-no-subtitle) > p:nth-child(2)) {
		font-size: 0.8em;
		line-height: 1.3;
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
		/* 공백 없는 긴 URL도 줄바꿈되게(가로 스크롤 방지). */
		overflow-wrap: anywhere;
	}

	/* Inline image preview widget (decoration; not part of the doc). The
	   underlying text (including any <link:url> mark) is preserved verbatim
	   for round-trip compatibility with Tomboy desktop.

	   Sizing: width-only — natural size up to the note's visible width
	   (max-width: 100%), then shrink to fit. Tall images extend past the
	   viewport vertically and scroll, rather than being squeezed thin by
	   a height cap. */
	.tomboy-editor :global(img.tomboy-image-preview) {
		display: block;
		max-width: 100%;
		width: auto;
		height: auto;
		margin: 0.4em 0;
		border-radius: 4px;
		background: rgba(0, 0, 0, 0.04);
		cursor: pointer;
		/* Long-press opens our own image action menu (이미지 복사 / 주소 복사);
		   suppress iOS's native callout so it doesn't fight the gesture. */
		-webkit-touch-callout: none;
		user-select: none;
		-webkit-user-select: none;
	}

	/* Image-URL text is hidden so the image alone represents the link.
	   Delete / ArrowLeft / ArrowRight are intercepted in the plugin so the
	   hidden URL behaves atomically — i.e. Backspace at the end of the URL
	   removes the whole URL, arrow keys skip across it. */
	.tomboy-editor :global(.tomboy-image-url-hidden) {
		display: none;
	}

	.tomboy-editor :global(.tomboy-geo-map) {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		aspect-ratio: 1 / 1;
		margin: 8px 0;
		background: #f0f0f0;
		border-radius: 4px;
		overflow: hidden;
		color: #888;
		font-size: 0.85rem;
	}
	/* Once Leaflet mounts, its container fills the box. The flex centering
	   above only affects the placeholder text while loading. */
	.tomboy-editor :global(.tomboy-geo-map .leaflet-container) {
		width: 100%;
		height: 100%;
	}

	/* 노트 묶음: 체크 시 선언 라인/리스트 숨김 (노드 + inline 데코레이션 클래스).
	   prefix 있는 선언 라인은 키워드만 inline 으로 숨겨 앞 옵션 텍스트는 남긴다. */
	.tomboy-editor :global(.tomboy-note-bundle-hidden) {
		display: none;
	}
	.tomboy-editor :global(.tomboy-note-bundle) {
		display: block;
	}

	/* 음악제어 데이터 블록: 제어 노트에서만 마커 단락 숨김. */
	.tomboy-editor :global(.tomboy-music-control-hidden) {
		display: none;
	}

	/* Highlight */
	.tomboy-editor :global(mark) {
		background-color: #fff176;
	}

	/* In-note find matches (decorations — never part of the document). */
	.tomboy-editor :global(.tomboy-find-match) {
		background-color: #a5d6a7;
		border-radius: 2px;
	}
	.tomboy-editor :global(.tomboy-find-active) {
		background-color: #66bb6a;
		box-shadow: 0 0 0 1px #2e7d32;
	}

	/* HR split layout.
	   A top-level paragraph whose entire text is `---` (3+ dashes) is a
	   virtual horizontal-rule marker. `.tomboy-hr-marker` paints it as a
	   thin grey line (text hidden). Ctrl/Cmd+click toggles a marker
	   "active": N active markers split the doc into N+1 columns, active
	   markers render as the vertical dividers between columns, and any
	   still-inactive markers continue rendering as horizontal lines
	   inside their own column.

	   When at least one marker is active the editor root becomes a CSS
	   Grid: `grid-template-columns` alternates `1fr` (content) and
	   `auto` (divider) tracks, and `grid-template-rows: masonry` packs
	   each column independently so items in different columns no longer
	   share row heights — a tall image on one side no longer forces a
	   matching gap on the other.

	   Masonry currently ships in Firefox only and as of 2026-Q1 still
	   needs `layout.css.grid-template-masonry-value.enabled` flipped on.
	   See the tomboy-hrsplit skill for the gory details, including why
	   wrapping children doesn't work and why the divider height is
	   measured at runtime via a CSS variable on view.dom. */

	.tomboy-editor :global(.tomboy-hr-marker) {
		position: relative;
		/* Hide the literal `---` text but keep the paragraph clickable
		   and editable (caret still visible if the user steps inside it). */
		color: transparent;
		caret-color: #333;
		min-height: 1.2em;
		margin: 0.6em 0;
		padding: 0;
		/* Default cursor: not clickable. Only Ctrl/Cmd held makes the
		   marker actionable; the hover effect below is similarly gated. */
		cursor: default;
	}
	/* Pointer cursor + hover affordance only when Ctrl is held (mirrors
	   the click handler's own gate, so the visual matches the interaction). */
	.tomboy-editor.tomboy-todo-ctrl-hold :global(.tomboy-hr-marker) {
		cursor: pointer;
	}
	.tomboy-editor :global(.tomboy-hr-marker::before) {
		/* Default state: thin grey horizontal line centered in the row. */
		content: "";
		position: absolute;
		inset: 0;
		background: linear-gradient(
			to bottom,
			transparent calc(50% - 0.5px),
			#b0b0b0 calc(50% - 0.5px),
			#b0b0b0 calc(50% + 0.5px),
			transparent calc(50% + 0.5px)
		);
		pointer-events: none;
	}
	.tomboy-editor.tomboy-todo-ctrl-hold
		:global(.tomboy-hr-marker:hover::before) {
		background: linear-gradient(
			to bottom,
			transparent calc(50% - 1px),
			#888 calc(50% - 1px),
			#888 calc(50% + 1px),
			transparent calc(50% + 1px)
		);
	}

	/* `===` 단독 라인 → 굵은 수평선. `---`(.tomboy-hr-marker)보다 두껍고
	   진하게. 인덱스 0(제목)은 데코레이션되지 않으므로 영향 없음. 첫 마커는
	   고정 헤더 경계(.tomboy-eq-marker-active)이며 살짝 더 진하다. 미러
	   오버레이 자체의 스타일은 StickyHeader.svelte 안에 있다. */
	.tomboy-editor :global(.tomboy-eq-marker) {
		position: relative;
		color: transparent;
		caret-color: #333;
		min-height: 1.2em;
		margin: 0.8em 0;
		padding: 0;
	}
	.tomboy-editor :global(.tomboy-eq-marker::before) {
		content: "";
		position: absolute;
		inset: 0;
		background: linear-gradient(
			to bottom,
			transparent calc(50% - 1px),
			#555 calc(50% - 1px),
			#555 calc(50% + 1px),
			transparent calc(50% + 1px)
		);
		pointer-events: none;
	}
	.tomboy-editor :global(.tomboy-eq-marker-active::before) {
		background: linear-gradient(
			to bottom,
			transparent calc(50% - 1.25px),
			#222 calc(50% - 1.25px),
			#222 calc(50% + 1.25px),
			transparent calc(50% + 1.25px)
		);
	}

	/* HR fold — 섹션 접기/펼치기.
	   Each non-empty section's HR marker hosts a small +/− widget button
	   (hrFoldPlugin), and the HR line itself is plain-click toggleable
	   (.tomboy-hr-fold-line). Folding a section clamps its first block to
	   one visual line and hides the rest.
	   Mutually exclusive with the split layout — while columns are
	   active the fold plugin emits no decorations at all, and while any
	   section is folded the split Ctrl+click toggle is ignored. */
	.tomboy-editor :global(.tomboy-hr-fold-btn) {
		position: absolute;
		right: 0;
		top: 50%;
		transform: translateY(-50%);
		width: 22px;
		height: 22px;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		border: 1.5px solid #777;
		border-radius: 4px;
		background: #fff;
		/* Explicit colour — the parent .tomboy-hr-marker hides its literal
		   `---` text via `color: transparent`, which would otherwise be
		   inherited by the button glyph. */
		color: #333;
		font-size: 15px;
		font-weight: 700;
		line-height: 1;
		cursor: pointer;
		user-select: none;
		opacity: 0.9;
		z-index: 1;
	}
	.tomboy-editor :global(.tomboy-hr-fold-btn:hover) {
		opacity: 1;
		color: #000;
		border-color: #444;
		background: #f2f2f2;
	}
	/* Whole HR line is clickable to fold/unfold its section (plain click;
	   Ctrl/Cmd+click stays the split toggle). Pointer cursor + hover
	   thickening signal the affordance without any modifier key. */
	.tomboy-editor :global(.tomboy-hr-marker.tomboy-hr-fold-line) {
		cursor: pointer;
	}
	.tomboy-editor :global(.tomboy-hr-marker.tomboy-hr-fold-line:hover::before) {
		background: linear-gradient(
			to bottom,
			transparent calc(50% - 1px),
			#888 calc(50% - 1px),
			#888 calc(50% + 1px),
			transparent calc(50% + 1px)
		);
	}
	/* Folded section: first block clamped to a single visual line. */
	.tomboy-editor :global(.tomboy-hr-fold-clamped) {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 1;
		line-clamp: 1;
		overflow: hidden;
	}
	/* Folded section: remaining blocks fully hidden. */
	.tomboy-editor :global(.tomboy-hr-fold-hidden) {
		display: none;
	}

	/* Labeled-divider list accordion — 그룹당 한 리스트만 펼침. 토글은 라벨
	   디바이더(타이틀) 자체를 클릭(.tomboy-labeled-foldable, handleClick).
	   숨김은 소유 리스트 블록에 display:none. */
	.tomboy-editor :global(.tomboy-labeled-fold-hidden) {
		display: none;
	}

	/* Labeled divider — a divider line with embedded text. The literal
	   markup (`-- label --` / `label ---`) lives in a plain paragraph;
	   labeledDividerPlugin hides the dash runs and styles the label.
	   `::before` paints the line (same gradient/colour as the hr-marker);
	   the label sits above it with an opaque background that punches a
	   gap through the line. */
	.tomboy-editor :global(.tomboy-labeled-divider) {
		position: relative;
		/* Create a stacking context so the ::before line (z-index:0) and
		   the label span (z-index:1) layer reliably within this paragraph. */
		isolation: isolate;
		/* Generous vertical margin — neighbouring paragraphs have margin:0,
		   so this is the whole gap. Wider than the hr-marker's 0.6em so the
		   divider breathes without the user adding blank lines by hand. */
		margin: 1.5em 0;
		min-height: 1.2em;
		padding: 0.5em 0;
	}
	.tomboy-editor :global(.tomboy-labeled-divider--center) {
		text-align: center;
	}
	.tomboy-editor :global(.tomboy-labeled-divider--left) {
		text-align: left;
		/* Left padding leaves a short stub of line before the label. */
		padding-left: 1.6em;
	}
	.tomboy-editor :global(.tomboy-labeled-divider::before) {
		content: "";
		position: absolute;
		inset: 0;
		z-index: 0;
		background: linear-gradient(
			to bottom,
			transparent calc(50% - 0.5px),
			#b0b0b0 calc(50% - 0.5px),
			#b0b0b0 calc(50% + 0.5px),
			transparent calc(50% + 0.5px)
		);
		pointer-events: none;
	}
	/* Dash runs: collapsed to zero width so a long trailing run never
	   shifts layout. Still caret-steppable. */
	.tomboy-editor :global(.tomboy-labeled-divider-mark) {
		font-size: 0;
	}
	/* The visible label. The opaque background must match the editor
	   surface (white) so the label cuts a clean gap through the line
	   drawn behind it. */
	.tomboy-editor :global(.tomboy-labeled-divider-label) {
		position: relative;
		z-index: 1;
		background: #fff;
		padding: 0 0.5em;
		color: #666;
		font-size: 0.85em;
	}

	/* Labeled-divider accordion box — frames a group's member+list run (a
	   group with ≥2 list-bearing members = the exclusive accordion) in a
	   1×N table rectangle. Drawn with per-block borders because PM forbids
	   wrapping its children (see the tomboy-hrsplit skill); each boxed block
	   collapses its vertical margins so the left/right borders stay
	   continuous. The labeled dividers inside keep their ::before line +
	   label as the row separators; the first member divider is the top edge,
	   the last visible block the bottom edge. Auto-suppressed in the 나란히
	   보기 split layout (the fold plugin emits nothing there). */
	.tomboy-editor :global(.tomboy-labeled-box) {
		border-left: 1px solid #b0b0b0;
		border-right: 1px solid #b0b0b0;
		margin-top: 0;
		margin-bottom: 0;
		background: #fcfcfc;
	}
	/* Side padding on the row bodies (lists / interleaved text); dividers
	   keep their own padding so their full-width ::before line still meets
	   both side borders. Generous left inset so list bullets don't crowd the
	   border. */
	.tomboy-editor :global(.tomboy-labeled-box):not(.tomboy-labeled-divider) {
		padding-left: 1.6em;
		padding-right: 1em;
		padding-top: 0.35em;
		padding-bottom: 0.35em;
	}
	/* Top edge = first member divider. The border passes THROUGH the label
	   (same look as the interior dividers) rather than floating above it: the
	   paragraph collapses to just the top border line and the label is lifted
	   to straddle it, its background punching a clean gap. */
	.tomboy-editor :global(.tomboy-labeled-box-top) {
		border-top: 1px solid #b0b0b0;
		border-top-left-radius: 7px;
		border-top-right-radius: 7px;
		margin-top: 0;
		padding-top: 0;
		padding-bottom: 0;
		min-height: 0;
		line-height: 0;
	}
	.tomboy-editor :global(.tomboy-labeled-box-top::before) {
		display: none;
	}
	.tomboy-editor
		:global(.tomboy-labeled-box-top .tomboy-labeled-divider-label) {
		display: inline-block;
		line-height: 1.3;
		position: relative;
		top: -0.62em;
		/* match the box surface so the label cuts the top border cleanly */
		background: #fcfcfc;
	}
	/* Foldable member divider — the label line is the accordion toggle (no
	   +/− button). Pointer + hover underline signal it's clickable. */
	.tomboy-editor :global(.tomboy-labeled-foldable) {
		cursor: pointer;
	}
	.tomboy-editor
		:global(.tomboy-labeled-foldable:hover .tomboy-labeled-divider-label) {
		color: #000;
		text-decoration: underline;
	}
	/* Bottom edge = last visible block (a list when its member is open, else
	   the trailing divider). */
	.tomboy-editor :global(.tomboy-labeled-box-bottom) {
		border-bottom: 1px solid #b0b0b0;
		border-bottom-left-radius: 7px;
		border-bottom-right-radius: 7px;
	}

	.tomboy-editor :global(.tiptap.tomboy-hr-split-active) {
		display: grid;
		/* grid-template-columns is set via inline `style` emitted by the
		   plugin — alternates `1fr` and `auto` based on the active count. */
		grid-template-rows: masonry;
		column-gap: 12px;
		row-gap: 0;
		/* Defense in depth for the non-masonry fallback path. The plugin's
		   view() hook already bails on !CSS.supports masonry, but keeping
		   `start` here means even if a future change tries to size the
		   divider in fallback mode, items in the shared row won't stretch
		   to the divider's height and feed a measurement loop. With
		   masonry active this rule is a no-op on the masonry axis. */
		align-items: start;
	}
	.tomboy-editor :global(.tiptap.tomboy-hr-split-active > *) {
		min-width: 0;
	}
	/* Active divider: vertical line in its assigned divider track. Same
	   colour as the inactive horizontal line so the two states look like
	   the same primitive rotated 90°. `height` is driven by the
	   `--hr-split-divider-height` custom property set on view.dom by the
	   plugin's view() hook (masonry has no defined track height along the
	   masonry axis, so we measure the tallest content column at runtime).
	   The variable lives on view.dom rather than the divider element so
	   PM's DOMObserver ignores the mutation — see hrSplitPlugin.ts. */
	.tomboy-editor
		:global(.tiptap.tomboy-hr-split-active > .tomboy-hr-split-divider) {
		margin: 0;
		min-height: 0;
		width: 12px;
		caret-color: transparent;
		height: var(--hr-split-divider-height, auto);
		/* Drag-to-resize affordance. Ctrl/Cmd-hold restores `cursor: pointer`
		   via the higher-specificity `.tomboy-todo-ctrl-hold .tomboy-hr-marker`
		   rule above, so the toggle gesture still feels clickable. */
		cursor: col-resize;
		touch-action: none;
		user-select: none;
	}
	/* While a divider drag is active, suppress text selection across the
	   whole grid and lock the col-resize cursor regardless of where the
	   pointer ends up. */
	.tomboy-editor
		:global(.tiptap.tomboy-hr-split-active.tomboy-hr-split-dragging) {
		cursor: col-resize;
		user-select: none;
	}
	.tomboy-editor
		:global(.tiptap.tomboy-hr-split-active.tomboy-hr-split-dragging *) {
		cursor: col-resize !important;
		user-select: none;
	}
	.tomboy-editor
		:global(
			.tiptap.tomboy-hr-split-active > .tomboy-hr-split-divider::before
		) {
		background: linear-gradient(
			to right,
			transparent calc(50% - 0.5px),
			#b0b0b0 calc(50% - 0.5px),
			#b0b0b0 calc(50% + 0.5px),
			transparent calc(50% + 0.5px)
		);
	}
	.tomboy-editor.tomboy-todo-ctrl-hold
		:global(
			.tiptap.tomboy-hr-split-active
				> .tomboy-hr-split-divider:hover::before
		) {
		background: linear-gradient(
			to right,
			transparent calc(50% - 1px),
			#888 calc(50% - 1px),
			#888 calc(50% + 1px),
			transparent calc(50% + 1px)
		);
	}

	/* List items */
	.tomboy-editor :global(ul) {
		padding-left: 1.5em;
	}

	/* "보내기" mode: bigger bullets so the user sees the mode is active,
	   and room on the right for the floating button. */
	.tomboy-editor :global(.tomboy-send-active li) {
		position: relative;
		padding-right: 7.2em;
		list-style: none;
		border-radius: 3px;
		transition: background-color 0.1s;
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
	/* Hover highlight so the user can see which row the 보내기 button targets,
	   mirroring the TODO ctrl-hold tint. When a nested li is hovered, suppress
	   the parent's tint so only the deepest hovered row is highlighted. */
	.tomboy-editor :global(.tomboy-send-active li:hover) {
		background-color: rgba(52, 101, 164, 0.1);
	}
	.tomboy-editor :global(.tomboy-send-active li:has(li:hover)) {
		background-color: transparent;
	}
	.tomboy-editor :global(.tomboy-send-li-actions) {
		position: absolute;
		right: 0;
		top: 0;
		display: flex;
		gap: 4px;
	}
	.tomboy-editor :global(.tomboy-send-li-btn),
	.tomboy-editor :global(.tomboy-skip-li-btn) {
		padding: 2px 8px;
		font-size: 0.75rem;
		line-height: 1.3;
		color: #fff;
		border: none;
		border-radius: 3px;
		cursor: pointer;
		user-select: none;
	}
	.tomboy-editor :global(.tomboy-send-li-btn) {
		background: #3465a4;
	}
	.tomboy-editor :global(.tomboy-send-li-btn:hover) {
		background: #204a87;
	}
	/* 스킵 — 중립 회색(삭제/넘김). 보내기와 시각적으로 구분. */
	.tomboy-editor :global(.tomboy-skip-li-btn) {
		background: #888a85;
	}
	.tomboy-editor :global(.tomboy-skip-li-btn:hover) {
		background: #555753;
	}

	/* 플레이리스트 모드 트랙 행 — 글머리표 대신 ♪/재생아이콘 + 곡 제목. 체크 모드에선
	   li 가 contenteditable=false 라 행 전체가 재생 버튼(커서 진입 불가). */
	.tomboy-editor :global(li.music-track) {
		list-style: none;
		position: relative;
		/* 편집 중(체크 해제, 데코 없음)엔 인코딩된 긴 URL(%20 투성이, 공백 없는 한 토큰)이
		   그대로 노출된다 — 안 깨지면 음악노트만 가로 스크롤. 강제 줄바꿈. */
		overflow-wrap: anywhere;
		word-break: break-word;
	}
	.tomboy-editor :global(li.music-track--play) {
		cursor: pointer;
	}
	.tomboy-editor :global(li.music-track--playing) {
		background: var(--accent-soft, #faf2f7);
		border-radius: 6px;
	}
	/* display 제목 위젯이 보여지는 동안 실제 URL/원문은 숨김(편집 시 데코 제거→복원). */
	.tomboy-editor :global(.music-row-hide) {
		display: none;
	}
	.tomboy-editor :global(.music-track-name) {
		/* 행 전체를 덮어 어디를 탭해도 재생되게 — display 텍스트 한 줄만큼 폭 확보. */
		display: flex;
		align-items: center;
		gap: 0.3em;
		width: 100%;
		cursor: pointer;
		padding: 0.1em 0;
	}
	.tomboy-editor :global(.music-track-mark) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.1em;
		color: var(--accent, #a05);
	}
	.tomboy-editor :global(.music-track-mark .music-track-eq) {
		margin-right: 0;
	}
	.tomboy-editor :global(.music-track-label) {
		color: var(--text, #222);
	}
	.tomboy-editor :global(.music-track-eq) {
		display: inline-flex;
		gap: 2px;
		align-items: flex-end;
		height: 0.85em;
		margin-right: 0.35em;
		vertical-align: -0.1em;
	}
	.tomboy-editor :global(.music-track-eq i) {
		width: 2.5px;
		background: var(--accent, #a05);
		border-radius: 1px;
		animation: music-eq 1s ease-in-out infinite;
	}
	.tomboy-editor :global(.music-track-eq i:nth-child(1)) {
		height: 45%;
		animation-delay: 0s;
	}
	.tomboy-editor :global(.music-track-eq i:nth-child(2)) {
		height: 100%;
		animation-delay: 0.2s;
	}
	.tomboy-editor :global(.music-track-eq i:nth-child(3)) {
		height: 65%;
		animation-delay: 0.4s;
	}
	@keyframes music-eq {
		0%,
		100% {
			transform: scaleY(0.5);
		}
		50% {
			transform: scaleY(1);
		}
	}
	.tomboy-editor :global(.music-track-eq--paused i) {
		animation-play-state: paused;
	}
	/* 플레이리스트 헤더('플레이리스트:' 줄) — 우측 ▶(전체 재생) 절대배치 기준. */
	.tomboy-editor :global(p.music-pl-header) {
		position: relative;
		padding-right: 2.4em;
	}
	.tomboy-editor :global(.music-pl-play-btn) {
		/* 헤더 우측에 고정 — float 는 짧은 줄끼리 겹쳐 계단식으로 쌓이므로 절대배치. */
		position: absolute;
		right: 0.2em;
		top: 0;
		border: 1px solid var(--border, #e0e0dc);
		border-radius: 6px;
		background: var(--surface, #fff);
		color: var(--accent, #a05);
		font-size: 0.8em;
		width: 1.9em;
		height: 1.9em;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0;
	}
	.tomboy-editor :global(.music-pl-play-btn:hover) {
		background: var(--accent-soft, #faf2f7);
	}

	/* 곡 행 우측 편집 도구(▲▼ 순서 · ⧉ 복사 · 🗑 삭제). 기본 숨김이고 Ctrl(⌘)을
	   누르는 동안만(.music-ctrl-held 가 ProseMirror 루트에 붙음) 노출. li.music-track
	   이 position:relative 라 우측 절대배치 기준이 된다. */
	.tomboy-editor :global(.music-track-tools) {
		position: absolute;
		right: 0.2em;
		top: 50%;
		transform: translateY(-50%);
		display: none;
		gap: 0.1em;
		align-items: center;
		background: var(--surface, #fff);
		border: 1px solid var(--border, #e0e0dc);
		border-radius: 7px;
		padding: 0.1em 0.2em;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
		z-index: 3;
	}
	.tomboy-editor :global(.music-ctrl-held .music-track-tools) {
		display: inline-flex;
	}
	.tomboy-editor :global(.music-track-tool) {
		border: none;
		background: transparent;
		color: var(--text, #444);
		font-size: 0.78em;
		line-height: 1;
		width: 1.7em;
		height: 1.7em;
		cursor: pointer;
		border-radius: 5px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0;
	}
	.tomboy-editor :global(.music-track-tool:hover:not(:disabled)) {
		background: var(--accent-soft, #faf2f7);
	}
	.tomboy-editor :global(.music-track-tool:disabled) {
		opacity: 0.3;
		cursor: default;
	}

	.tomboy-editor :global(.tomboy-music-extract-run),
	.tomboy-editor :global(.tomboy-bridge-run) {
		display: inline-flex;
		align-items: center;
		gap: 0.3em;
		margin: 0.2rem 0 0.4rem;
		padding: 0.25rem 0.7rem;
		font-size: 0.85rem;
		border: 1px solid var(--border, #ddd);
		border-radius: 6px;
		background: var(--surface, #fff);
		color: var(--accent, #a05);
		cursor: pointer;
	}
	.tomboy-editor :global(.tomboy-music-extract-run:disabled),
	.tomboy-editor :global(.tomboy-bridge-run:disabled) {
		opacity: 0.6;
		cursor: default;
	}
	.tomboy-editor :global(.tomboy-music-extract-makenote) {
		display: inline-flex;
		align-items: center;
		gap: 0.3em;
		margin-left: 0.5em;
		padding: 0.1rem 0.55rem;
		font-size: 0.8rem;
		border: 1px solid var(--border, #ddd);
		border-radius: 6px;
		background: var(--surface, #fff);
		color: var(--accent, #a05);
		cursor: pointer;
		vertical-align: middle;
		user-select: none;
	}
	.tomboy-editor :global(.tomboy-music-extract-makenote:disabled) {
		opacity: 0.6;
		cursor: default;
	}
	.tomboy-editor :global(.tomboy-suno-import) {
		display: inline-flex;
		align-items: center;
		gap: 0.3em;
		margin-left: 0.5em;
		padding: 0.1rem 0.55rem;
		font-size: 0.8rem;
		vertical-align: middle;
		border: 1px solid var(--border, #ddd);
		border-radius: 6px;
		background: var(--surface, #fff);
		color: var(--accent, #a05);
		cursor: pointer;
	}
	.tomboy-editor :global(.tomboy-suno-import:disabled) {
		opacity: 0.6;
		cursor: default;
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
	/* In split mode the editor root is a CSS Grid; the arrow row is a PM
	   widget decoration (not a doc node), so hrSplitPlugin can't assign it
	   a grid-column. Span all columns like a header so the arrows sit on
	   the outer edges of the full note width instead of inside column 1. */
	.tomboy-editor :global(.tomboy-hr-split-active > .datelink-arrow-row) {
		grid-column: 1 / -1;
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

	/* Subtitle (second line) creation-date placeholder. Applied whenever the
	   second paragraph is empty (including while the caret sits on it) — see
	   TomboySubtitlePlaceholder. */
	.tomboy-editor :global(.tiptap p.tomboy-subtitle-placeholder::before) {
		color: #909090;
		/* Own attribute — the built-in Placeholder overwrites `data-placeholder`
		   on the caret's node, so reading it here would show "Start typing..."
		   on the empty subtitle line (see TomboySubtitlePlaceholder). */
		content: attr(data-subtitle-placeholder);
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

	/* 프로세스(멀티스테이지 칸반) 항목별 이전/다음 버튼. TODO 와 동일하게
	   widget 데코로 각 li 안에 들어가며, 가시성은 (a) 창에서 Ctrl/Cmd 눌림
	   = .tomboy-todo-ctrl-hold 클래스 + (b) 해당 li hover 로 게이트된다.
	   첫 단계는 '다음'만, 마지막 단계는 '이전'만, 중간 단계는 둘 다. */
	.tomboy-editor :global(li.tomboy-process-item) {
		position: relative;
		border-radius: 3px;
		transition: background-color 0.1s;
	}
	.tomboy-editor.tomboy-todo-ctrl-hold
		:global(li.tomboy-process-item:hover) {
		background-color: rgba(21, 101, 192, 0.1);
	}
	.tomboy-editor :global(.tomboy-process-btns) {
		position: absolute;
		right: 0;
		top: 0;
		display: inline-flex;
		gap: 4px;
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.1s;
		z-index: 1;
	}
	.tomboy-editor :global(.tomboy-process-prev-btn),
	.tomboy-editor :global(.tomboy-process-next-btn) {
		padding: 2px 8px;
		font-size: 0.75rem;
		line-height: 1.3;
		border: none;
		border-radius: 3px;
		cursor: pointer;
		user-select: none;
		color: #fff;
	}
	.tomboy-editor :global(.tomboy-process-prev-btn) {
		background: #757575;
	}
	.tomboy-editor :global(.tomboy-process-prev-btn:hover) {
		background: #555;
	}
	.tomboy-editor :global(.tomboy-process-next-btn) {
		background: #1565c0;
	}
	.tomboy-editor :global(.tomboy-process-next-btn:hover) {
		background: #0d47a1;
	}
	.tomboy-editor.tomboy-todo-ctrl-hold
		:global(li.tomboy-process-item:hover > .tomboy-process-btns) {
		opacity: 1;
		pointer-events: auto;
	}
	/* 깊은(중첩) 항목 hover 시 부모 단계 항목의 버튼은 숨겨 한 행만 노출. */
	.tomboy-editor.tomboy-todo-ctrl-hold
		:global(
			li.tomboy-process-item:has(li.tomboy-process-item:hover)
				> .tomboy-process-btns
		) {
		opacity: 0;
		pointer-events: none;
	}
	/* 터치 기기는 hover 가 없으므로 모바일 Ctrl 고정 시 hover 없이 노출. */
	@media (hover: none), (pointer: coarse) {
		.tomboy-editor.tomboy-todo-ctrl-hold
			:global(li.tomboy-process-item .tomboy-process-btns) {
			opacity: 1;
			pointer-events: auto;
		}
	}

	/* 체크리스트 영역 항목 — 불릿 대신 체크박스 위젯. checklist 플러그인이
	   영역 안의 각 listItem 에 .tomboy-checkbox-item 노드 데코와 첫 문단
	   시작 위치에 .tomboy-checkbox-box 위젯을 단다. */
	.tomboy-editor :global(li.tomboy-checkbox-item) {
		list-style: none;
	}
	/* 체크된 항목은 자기 직계 문단만 흐리게 — 중첩 자식 항목은 제외. */
	.tomboy-editor :global(li.tomboy-checkbox-item.is-checked > p) {
		opacity: 0.6;
	}
	/* 인라인 [x] 체크박스와 같은 자체 SVG(currentColor)를 재사용한다 —
	   buildCheckbox 가 .tomboy-cb-svg 를 button 안에 그려넣고, SVG 자식
	   스타일(.tomboy-cb-box/-check)은 인라인 체크박스 규칙을 공유한다.
	   여기서는 불릿 자리 정렬용 박스모델만 둔다. */
	.tomboy-editor :global(.tomboy-checkbox-box) {
		display: inline-block;
		width: 1em;
		height: 1em;
		/* 폭 1em + 우측 0.4em 만큼 음수 마진 — 위젯이 ul 패딩(1.5em)의
		   불릿 자리로 들어가고, 항목 텍스트는 일반 불릿 항목 텍스트와
		   같은 x 에서 시작한다. */
		margin-left: -1.4em;
		margin-right: 0.4em;
		padding: 0;
		vertical-align: -0.12em;
		border: none;
		background: none;
		color: currentColor;
		cursor: pointer;
		box-sizing: border-box;
	}

	/* 항목 단위 라디오 — listBox 플러그인이 boxKind='radio' listItem 에
	   .tomboy-radio-item 노드 데코와 첫 문단 시작에 .tomboy-radio-box
	   위젯을 단다. checkbox kind 는 위 체크리스트 CSS 를 그대로 재사용. */
	.tomboy-editor :global(li.tomboy-radio-item) {
		list-style: none;
	}
	.tomboy-editor :global(.tomboy-radio-box) {
		display: inline-block;
		width: 1em;
		height: 1em;
		margin-left: -1.4em; /* 체크박스와 동일 — 불릿 자리 정렬 */
		margin-right: 0.4em;
		padding: 0;
		vertical-align: -0.12em;
		border: 1.5px solid #888;
		border-radius: 50%;
		background: #fff;
		cursor: pointer;
	}
	.tomboy-editor :global(.tomboy-radio-box.is-selected) {
		border-color: #1565c0;
		background: radial-gradient(
			circle,
			#1565c0 0%,
			#1565c0 45%,
			#fff 55%
		);
	}

	/* 각주 [^N] — footnoteMarker atomic 노드의 NodeView (footnote/node.ts) 가
	   참조는 <sup class="tomboy-fn-ref"> 작은 위첨자, 설명 마커는
	   <span class="tomboy-fn-def"> 일반 크기로 렌더한다. 마커는 .note XML
	   본문에 [^N] 텍스트로 그대로 직렬화된다. */
	.tomboy-editor :global(.tomboy-fn-ref) {
		font-size: 0.75em;
		vertical-align: super;
		line-height: 0;
		color: #2563eb;
		cursor: pointer;
		position: relative;
	}
	/* 모바일 hit-area — 위첨자는 작아 탭이 어렵다. 보이지 않는 ::before 가
	   상하 12px·좌우 8px 만큼 터치 영역을 넓힌다(pseudo 영역 탭도 sup 으로
	   히트되어 plugin 의 closest('.tomboy-fn-ref') 가 잡는다). 데스크탑은
	   hover 가 정밀하므로 손대지 않는다. */
	@media (hover: none), (pointer: coarse) {
		.tomboy-editor :global(.tomboy-fn-ref::before) {
			content: '';
			position: absolute;
			top: -12px;
			left: -8px;
			right: -8px;
			bottom: -12px;
		}
	}
	/* 설명 마커(줄 맨 앞 [^N]) — 일반 크기. 작은 위첨자면 설명 시작이
	   어색하므로 본문과 같은 크기·기준선으로 둔다. */
	.tomboy-editor :global(.tomboy-fn-def) {
		color: #2563eb;
		cursor: pointer;
	}
	/* 클릭 스크롤 도착 시 약 1.2초 하이라이트 깜빡임. */
	.tomboy-editor :global(.tomboy-fn-flash) {
		animation: tomboy-fn-flash 1.2s ease-out;
	}
	@keyframes -global-tomboy-fn-flash {
		from {
			background-color: rgba(250, 204, 21, 0.55);
		}
		to {
			background-color: transparent;
		}
	}

	/* 각주 미리보기 팝오버 — document.body 에 붙어 전역 클래스로 스타일.
	   데스크탑 hover 는 -static(pointer-events:none), 모바일 탭은 -jump 버튼 포함. */
	:global(.tomboy-fn-preview) {
		position: fixed;
		z-index: var(--z-menu);
		max-width: 300px;
		/* 길이 제한은 plugin 에서 글자수(데스크탑 전문 / 모바일 300자)로 두고,
		   여기서는 뷰포트를 넘지 않게 높이만 막는다(모바일은 내부 스크롤 가능). */
		max-height: 50vh;
		overflow-y: auto;
		padding: 0.5rem 0.625rem;
		background: #ffffff;
		border: 1px solid #d1d5db;
		border-radius: 0.5rem;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
		font-size: 0.8125rem;
		line-height: 1.4;
		color: #1f2937;
	}
	:global(.tomboy-fn-preview-static) {
		pointer-events: none;
	}
	:global(.tomboy-fn-preview-text) {
		white-space: pre-wrap;
		word-break: break-word;
	}
	:global(.tomboy-fn-preview-missing) {
		color: #6b7280;
		font-style: italic;
	}
	:global(.tomboy-fn-preview-jump) {
		display: inline-block;
		margin-top: 0.4rem;
		padding: 0.25rem 0.6rem;
		font-size: 0.8125rem;
		color: #ffffff;
		background: #2563eb;
		border: none;
		border-radius: 0.375rem;
		cursor: pointer;
	}

	/* 인라인 체크박스 — TomboyInlineCheckbox 노드의 NodeView 가
	   .tomboy-inline-checkbox span(내부에 인라인 SVG) 을 렌더한다.
	   18px 둥근 사각형 외곽선, 체크 시 모서리 밖으로 살짝 솟는 V.
	   색은 currentColor 로 그려 라이트/다크 글자색을 따른다(별도 색 없음).
	   모바일 hit-area 는 ::before 가 28×28 px 확보. */
	.tomboy-editor :global(.tomboy-inline-checkbox) {
		display: inline-block;
		width: 18px;
		height: 18px;
		vertical-align: -4px;
		margin: 0 2px;
		cursor: pointer;
		color: currentColor;
		user-select: none;
		position: relative;
		box-sizing: border-box;
	}

	/* 인라인 [x] 체크박스와 항목 단위 [[ ]] 체크박스(.tomboy-checkbox-box)가
	   같은 SVG 마크업을 쓰므로 자식 스타일을 공유한다. */
	.tomboy-editor :global(.tomboy-inline-checkbox .tomboy-cb-svg),
	.tomboy-editor :global(.tomboy-checkbox-box .tomboy-cb-svg) {
		display: block;
		width: 100%;
		height: 100%;
		overflow: visible; /* 모서리 밖으로 솟는 체크가 잘리지 않게 */
	}

	.tomboy-editor :global(.tomboy-inline-checkbox .tomboy-cb-box),
	.tomboy-editor :global(.tomboy-checkbox-box .tomboy-cb-box) {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.1;
		stroke-linejoin: round;
	}

	.tomboy-editor :global(.tomboy-inline-checkbox .tomboy-cb-check),
	.tomboy-editor :global(.tomboy-checkbox-box .tomboy-cb-check) {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.4;
		stroke-linecap: round;
		stroke-linejoin: round;
		display: none;
	}

	/* 차트가 켜진 헤더(.tomboy-chart-charted)에선 헤더 자체의 인라인 체크박스를
	   숨긴다 — 차트 좌상단 토글이 그 역할을 대체. base 체크박스 규칙과 같은
	   컴포넌트·같은 스코프에 둬야 specificity(스코프 해시 + 추가 클래스 = 0,4,0)와
	   소스 순서 모두에서 위 inline-block 규칙을 확실히 이긴다. app.css에서 같은
	   규칙을 쓰면 스코프 해시가 빠져 동점이 되어 밀린다. */
	.tomboy-editor :global(.tomboy-chart-charted > .tomboy-inline-checkbox) {
		display: none;
	}

	/* 모바일 hit-area — 보이지 않는 ::before 가 28x28 영역 확보. */
	.tomboy-editor :global(.tomboy-inline-checkbox::before) {
		content: '';
		position: absolute;
		top: -5px;
		left: -5px;
		right: -5px;
		bottom: -5px;
	}

	/* 체크 상태: 모서리 밖으로 솟는 V 표시. 인라인은 data-checked, 항목
	   단위 [[ ]] 체크박스는 .is-checked 로 같은 체크를 드러낸다. */
	.tomboy-editor :global(.tomboy-inline-checkbox[data-checked='true'] .tomboy-cb-check),
	.tomboy-editor :global(.tomboy-checkbox-box.is-checked .tomboy-cb-check) {
		display: inline;
	}

	.tomboy-editor :global(.tomboy-inline-checkbox:hover) {
		opacity: 0.6;
	}

	/* 인라인 라디오 — TomboyInlineRadio 노드의 NodeView 가
	   .tomboy-inline-radio span 을 렌더한다. 14px 원형, 모바일
	   hit-area 는 ::before 가 24×24 px 확보. 같은 textblock 의 다른
	   라디오와 상호 배타 (NodeView 클릭 핸들러). */
	.tomboy-editor :global(.tomboy-inline-radio) {
		display: inline-block;
		width: 14px;
		height: 14px;
		border: 1px solid var(--text-muted, #888);
		border-radius: 50%;
		vertical-align: -2px;
		margin: 0 2px;
		cursor: pointer;
		background: transparent;
		user-select: none;
		position: relative;
		box-sizing: border-box;
		transition: background-color 0.12s ease, border-color 0.12s ease;
	}

	.tomboy-editor :global(.tomboy-inline-radio::before) {
		content: '';
		position: absolute;
		top: -5px;
		left: -5px;
		right: -5px;
		bottom: -5px;
	}

	.tomboy-editor :global(.tomboy-inline-radio[data-selected='true']) {
		border-color: var(--accent, #4a76d4);
	}

	.tomboy-editor :global(.tomboy-inline-radio[data-selected='true']::after) {
		content: '';
		position: absolute;
		top: 50%;
		left: 50%;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background-color: var(--accent, #4a76d4);
		transform: translate(-50%, -50%);
	}

	.tomboy-editor :global(.tomboy-inline-radio:hover) {
		border-color: var(--accent, #4a76d4);
	}

	/* 인용 단락 — blockquote 플러그인이 '> ' 로 시작하는 최상위 단락에
	   .tomboy-quote 노드 데코를, 맨 앞 '> ' 2자에 .tomboy-quote-marker
	   폭 0 데코를 단다. 연속 인용은 인접 형제 선택자로 위 여백을 좁혀
	   한 덩어리처럼 보이게 한다. */
	.tomboy-editor :global(p.tomboy-quote) {
		border-left: 3px solid #d1d5db;
		padding-left: 0.9em;
		color: #4b5563;
	}
	.tomboy-editor :global(p.tomboy-quote + p.tomboy-quote) {
		margin-top: 0.2em;
	}
	.tomboy-editor :global(.tomboy-quote-marker) {
		font-size: 0;
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
		user-select: none;
	}
	.tomboy-editor :global(.tomboy-table-block-toggle) {
		position: absolute;
		top: 4px;
		right: 4px;
		display: inline-flex;
		align-items: center;
		opacity: 0;
		transition: opacity 0.12s;
		cursor: pointer;
		z-index: 1;
	}
	.tomboy-editor
		:global(.tomboy-table-block-widget:hover .tomboy-table-block-toggle) {
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
	/* Per-cell editor: a contenteditable span injected into the active
	   cell while the user is editing. Outline highlights the active slot;
	   the surrounding table chrome stays as-is so the user retains
	   spatial context (which row/column they're on). */
	.tomboy-editor :global(.tomboy-table-block-cell-editor) {
		display: inline-block;
		min-width: 1ch;
		outline: 2px solid #3465a4;
		outline-offset: -2px;
		background: #fff;
		caret-color: #3465a4;
	}
	/* While a cell is being edited, suppress the hover-only chrome (toggle
	   checkbox) so it doesn't flicker over the cell the user is editing. */
	.tomboy-editor
		:global(
			.tomboy-table-block-widget.tomboy-table-block-editing
				.tomboy-table-block-toggle
		) {
		display: none;
	}

	/* Ctrl-mode: structural edit chrome.
	   Layout strategy: the widget becomes a 2x2 grid:
	     ┌────────────┬───────┐
	     │   table    │  +col │   ← +col spans full table HEIGHT
	     ├────────────┼───────┤
	     │   +row     │       │   ← +row spans full table WIDTH
	     └────────────┴───────┘
	   The toggle checkbox (hover-only in non-ctrl) is suppressed in
	   favor of the structural-edit buttons. */
	.tomboy-editor
		:global(
			.tomboy-table-block-widget.tomboy-table-block-ctrl
				.tomboy-table-block-toggle
		) {
		display: none;
	}
	.tomboy-editor :global(.tomboy-table-block-widget.tomboy-table-block-ctrl) {
		display: grid;
		grid-template-columns: auto auto;
		grid-template-rows: auto auto;
		gap: 4px;
		width: max-content;
		max-width: 100%;
	}
	.tomboy-editor
		:global(
			.tomboy-table-block-widget.tomboy-table-block-ctrl
				> .tomboy-table-block-table
		) {
		grid-column: 1;
		grid-row: 1;
	}
	.tomboy-editor
		:global(
			.tomboy-table-block-widget.tomboy-table-block-ctrl
				> .tomboy-table-block-add-col
		) {
		grid-column: 2;
		grid-row: 1;
	}
	.tomboy-editor
		:global(
			.tomboy-table-block-widget.tomboy-table-block-ctrl
				> .tomboy-table-block-add-row
		) {
		grid-column: 1;
		grid-row: 2;
	}

	/* Per-cell action button (X). Lives INSIDE the cell, top-right
	   absolute. The cell carries `position: relative` so the X anchors
	   to the cell box, not the table or the widget. */
	.tomboy-editor :global(.tomboy-table-block-table th),
	.tomboy-editor :global(.tomboy-table-block-table td) {
		position: relative;
	}
	.tomboy-editor :global(.tomboy-table-block-action) {
		appearance: none;
		border: none;
		padding: 0;
		font: inherit;
		line-height: 1;
		cursor: pointer;
		user-select: none;
	}
	.tomboy-editor :global(.tomboy-table-block-del-col),
	.tomboy-editor :global(.tomboy-table-block-del-row) {
		position: absolute;
		top: 2px;
		right: 2px;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: #c43e3e;
		color: #fff;
		font-size: 11px;
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 2;
		/* Hidden until the JS reveal logic adds .action-show on the X
		   for the row+column under the cursor (see revealActionsForCell
		   in the plugin). pointer-events:none avoids the X stealing
		   hover when it's invisible. */
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.12s;
	}
	.tomboy-editor :global(.tomboy-table-block-action-show) {
		opacity: 0.85;
		pointer-events: auto;
	}
	.tomboy-editor :global(.tomboy-table-block-action-show:hover) {
		opacity: 1;
	}
	/* Hover-preview highlight: the cells about to be removed. */
	.tomboy-editor :global(.tomboy-table-block-target-row),
	.tomboy-editor :global(.tomboy-table-block-target-col) {
		background: rgba(196, 62, 62, 0.18) !important;
	}

	/* Insert-row / insert-col buttons fill their grid cell, so they
	   match the table's width / height respectively. Sized large enough
	   to be a comfortable click target (~32px on the short axis). */
	.tomboy-editor :global(.tomboy-table-block-add-col) {
		min-width: 32px;
		background: #2e7d32;
		color: #fff;
		font-size: 22px;
		font-weight: bold;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
	}
	.tomboy-editor :global(.tomboy-table-block-add-row) {
		min-height: 32px;
		background: #2e7d32;
		color: #fff;
		font-size: 22px;
		font-weight: bold;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
	}
	.tomboy-editor :global(.tomboy-table-block-add-col:hover),
	.tomboy-editor :global(.tomboy-table-block-add-row:hover) {
		background: #1b5e20;
	}

	/* Transient thinking display (PM widget decoration, Task 3/4).
	   Widget DOM is created by the plugin outside Svelte's scoped CSS
	   reach, so every selector below MUST be :global(...). The widget is
	   removed by clearStep before the next Q: paragraph is appended, so
	   it never persists in xmlContent — it's purely a streaming UI hint. */
	:global(.thinking-display) {
		margin: 0.5rem 0;
		padding: 0.4rem 0.6rem 0.4rem 0.8rem;
		border-left: 3px solid var(--border-color, #cbd5e1);
		background: var(--bg-subtle, rgba(127, 127, 127, 0.06));
		border-radius: 0 0.25rem 0.25rem 0;
		font-size: clamp(0.8rem, 1.5vw, 0.95rem);
		opacity: 0.78;
		user-select: none;
	}
	:global(.thinking-display[data-kind="tool_use"]) {
		border-left-color: #6b7c93;
	}
	:global(.thinking-display[data-kind="tool_result"]) {
		border-left-color: #4ade80;
	}
	:global(.thinking-display[data-kind="response_start"]) {
		border-left-color: #60a5fa;
	}
	:global(.thinking-display-label) {
		display: block;
		font-weight: 600;
		font-size: 0.85em;
		margin-bottom: 0.2rem;
		color: var(--text-muted, #64748b);
	}
	:global(.thinking-display-body) {
		margin: 0;
		padding: 0;
		border: none;
		white-space: pre-wrap;
		max-height: 12em;
		overflow: hidden;
		-webkit-mask-image: linear-gradient(to bottom, black 65%, transparent 100%);
		mask-image: linear-gradient(to bottom, black 65%, transparent 100%);
		font-family: inherit;
	}
	/* titleIsolation: 데코레이션으로 첫 top-level 줄(타이틀)을 숨긴다.
	   PM DOM 에 직접 붙는 클래스라 :global 필요. */
	:global(.ProseMirror .tomboy-title-hidden) {
		display: none;
	}
</style>
