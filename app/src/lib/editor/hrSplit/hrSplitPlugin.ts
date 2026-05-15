import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import {
	assignColumns,
	computeGridStyles,
	type BlockKind
} from './assignColumns.js';

interface PluginState {
	activeOrdinals: Set<number>;
	/** Per-column fr fractions, length = activeOrdinals.size + 1.
	 *  Equal-width columns are stored as `[1, 1, ...]`. */
	widths: number[];
}

interface ToggleMeta {
	toggle: number;
}

interface ReplaceMeta {
	replace: ReadonlyArray<number>;
	/** Optional initial column widths to apply alongside the active set.
	 *  Used by the host to seed persisted ratios when loading a note. */
	widths?: ReadonlyArray<number>;
}

interface ResizeMeta {
	/** New per-column fr fractions, length must equal totalColumns; values
	 *  must be positive finite numbers. Invalid arrays are ignored. */
	resize: ReadonlyArray<number>;
}

type Meta = ToggleMeta | ReplaceMeta | ResizeMeta;

function isToggle(m: Meta): m is ToggleMeta {
	return typeof (m as ToggleMeta).toggle === 'number';
}
function isReplace(m: Meta): m is ReplaceMeta {
	return Array.isArray((m as ReplaceMeta).replace);
}
function isResize(m: Meta): m is ResizeMeta {
	return Array.isArray((m as ResizeMeta).resize);
}

export const hrSplitPluginKey = new PluginKey<PluginState>('tomboyHrSplit');

export interface HrSplitOptions {
	/** Fired after every state-changing transition with the new and previous
	 *  active sets plus the new column widths. NOT called for `replace`
	 *  meta (note-load) since the host is already in sync with the
	 *  persisted state. */
	onChange?: (
		active: ReadonlySet<number>,
		widths: number[],
		prev: ReadonlySet<number>
	) => void;
	/** Optional gate. When this returns `false`, the click handler ignores
	 *  Ctrl+click and the decoration pass treats activeOrdinals as empty
	 *  (so persisted column splits don't bleed into a disabled context).
	 *  The `tomboy-hr-marker` class still applies to `---` paragraphs so
	 *  they render as horizontal lines. */
	enabled?: () => boolean;
}

/**
 * A top-level child is a virtual HR marker if it's a paragraph whose
 * entire text content (trimmed) is 3+ dashes. The first child is excluded
 * — the title paragraph always renders as a title.
 */
export function isDashParagraph(node: PMNode): boolean {
	if (node.type.name !== 'paragraph') return false;
	const text = node.textContent.trim();
	return /^-{3,}$/.test(text);
}

/** Number of leading top-level children excluded from the split layout.
 *  These are the title (index 0) and the subtitle/date line (index 1),
 *  which always render full-width above the split area. */
const HEADER_COUNT = 2;

/** Lower bound on any single column's share of (left + right) when
 *  dragging the divider between them. Keeps a column from being dragged
 *  down to invisibility. */
const MIN_COLUMN_FRACTION = 0.1;

function describeTopLevel(doc: PMNode): {
	kinds: BlockKind[];
	topLevelPositions: number[];
} {
	const kinds: BlockKind[] = [];
	const topLevelPositions: number[] = [];
	doc.forEach((node, offset, idx) => {
		topLevelPositions.push(offset);
		const isHrCandidate = idx >= HEADER_COUNT && isDashParagraph(node);
		kinds.push(isHrCandidate ? 'hr' : 'block');
	});
	return { kinds, topLevelPositions };
}

/** Find the top-level child index whose range contains `pos`. -1 if none. */
export function topLevelIndexAtPos(doc: PMNode, pos: number): number {
	let result = -1;
	doc.forEach((node, offset, idx) => {
		const end = offset + node.nodeSize;
		if (result < 0 && pos >= offset && pos < end) {
			result = idx;
		}
	});
	return result;
}

function countHrMarkers(doc: PMNode): number {
	const { kinds } = describeTopLevel(doc);
	let n = 0;
	for (const k of kinds) if (k === 'hr') n++;
	return n;
}

/** Find the HR-marker ordinal whose top-level index is `topIdx`, or -1. */
function ordinalOfTopIndex(doc: PMNode, topIdx: number): number {
	const { kinds } = describeTopLevel(doc);
	if (topIdx < 0 || topIdx >= kinds.length) return -1;
	if (kinds[topIdx] !== 'hr') return -1;
	let ord = 0;
	for (let i = 0; i < topIdx; i++) {
		if (kinds[i] === 'hr') ord++;
	}
	return ord;
}

interface Layout {
	decorations: DecorationSet;
	template: string | null;
}

function buildLayout(
	doc: PMNode,
	active: ReadonlySet<number>,
	widths: ReadonlyArray<number>,
	enabled: boolean
): Layout {
	const { kinds, topLevelPositions } = describeTopLevel(doc);
	// When the feature is disabled (e.g., mobile), force activeOrdinals to
	// empty so all HR markers stay h-lines and no grid layout kicks in,
	// even if localStorage holds non-empty state from another context.
	const effectiveActive: ReadonlySet<number> = enabled ? active : new Set();
	const { placements, totalColumns } = assignColumns({
		kinds,
		activeOrdinals: effectiveActive,
		headerCount: HEADER_COUNT
	});
	const effectiveWidths =
		enabled && widths.length === totalColumns ? widths : undefined;
	const { styleFor, template } = computeGridStyles(
		placements,
		totalColumns,
		effectiveWidths
	);

	const decos: Decoration[] = [];
	for (let i = 0; i < kinds.length; i++) {
		const isHr = kinds[i] === 'hr';
		const p = placements[i];
		const classes: string[] = [];
		if (isHr) classes.push('tomboy-hr-marker');
		if (p.role === 'v-divider') {
			classes.push('tomboy-hr-split-divider', 'tomboy-hr-marker-active');
		}
		// Tag headers with a class so the divider-height sync can skip
		// them by classList check — robust against the browser
		// reserializing inline styles (which makes any selector that
		// string-matches the raw `grid-column:1 / -1` unreliable).
		if (p.role === 'header' && totalColumns > 1) {
			classes.push('tomboy-hr-split-header');
		}
		const style = styleFor[i];
		if (classes.length === 0 && !style) continue;
		const from = topLevelPositions[i];
		const node = doc.child(i);
		const attrs: Record<string, string> = {};
		if (classes.length > 0) attrs.class = classes.join(' ');
		if (style) attrs.style = style;
		decos.push(Decoration.node(from, from + node.nodeSize, attrs));
	}
	return { decorations: DecorationSet.create(doc, decos), template };
}

function reconcileActiveAgainstDoc(
	doc: PMNode,
	active: ReadonlySet<number>
): { changed: boolean; next: Set<number> } {
	const hrCount = countHrMarkers(doc);
	const next = new Set<number>();
	let changed = false;
	for (const ord of active) {
		if (ord < hrCount) next.add(ord);
		else changed = true;
	}
	return { changed, next };
}

function equalWidths(n: number): number[] {
	const out = new Array<number>(Math.max(1, n));
	for (let i = 0; i < out.length; i++) out[i] = 1;
	return out;
}

function sanitizeWidths(
	candidate: ReadonlyArray<number>,
	totalColumns: number
): number[] | null {
	if (!Array.isArray(candidate)) return null;
	if (candidate.length !== totalColumns) return null;
	const out: number[] = [];
	for (const v of candidate) {
		if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
		out.push(v);
	}
	return out;
}

export function createHrSplitPlugin(options: HrSplitOptions = {}): Plugin {
	return new Plugin<PluginState>({
		key: hrSplitPluginKey,
		state: {
			init(): PluginState {
				return { activeOrdinals: new Set(), widths: [1] };
			},
			apply(tr: Transaction, prev: PluginState, _oldState, newState): PluginState {
				const meta = tr.getMeta(hrSplitPluginKey) as Meta | undefined;
				let activeNext = prev.activeOrdinals;
				let widthsNext = prev.widths;
				let activeChanged = false;
				let widthsExplicitlySet = false;
				let cameFromReplace = false;

				if (meta) {
					if (isReplace(meta)) {
						const replacedActive = new Set(
							meta.replace.filter(n => Number.isInteger(n) && n >= 0)
						);
						activeNext = replacedActive;
						activeChanged = true;
						cameFromReplace = true;
						if (meta.widths) {
							const sanitized = sanitizeWidths(
								meta.widths,
								replacedActive.size + 1
							);
							if (sanitized) {
								widthsNext = sanitized;
								widthsExplicitlySet = true;
							}
						}
					} else if (isToggle(meta)) {
						activeNext = new Set(prev.activeOrdinals);
						if (activeNext.has(meta.toggle)) activeNext.delete(meta.toggle);
						else activeNext.add(meta.toggle);
						activeChanged = true;
					} else if (isResize(meta)) {
						const sanitized = sanitizeWidths(
							meta.resize,
							prev.activeOrdinals.size + 1
						);
						if (sanitized) {
							widthsNext = sanitized;
							widthsExplicitlySet = true;
						}
					}
				}

				let prunedByDoc = false;
				if (tr.docChanged) {
					const { changed, next: reconciled } = reconcileActiveAgainstDoc(
						newState.doc,
						activeNext
					);
					if (changed) {
						activeNext = reconciled;
						prunedByDoc = true;
						activeChanged = true;
					}
				}

				const totalColumns = activeNext.size + 1;
				if (!widthsExplicitlySet) {
					if (activeChanged || widthsNext.length !== totalColumns) {
						// Active set just shifted (toggle, replace without widths,
						// or doc-prune) — reset to equal widths. The previous
						// custom ratio doesn't make sense for a different column
						// count.
						widthsNext = equalWidths(totalColumns);
					}
				} else if (widthsNext.length !== totalColumns) {
					// Defensive: the meta's widths array was the wrong length
					// after reconciliation. Fall back to equal.
					widthsNext = equalWidths(totalColumns);
				}

				if (
					activeNext === prev.activeOrdinals &&
					widthsNext === prev.widths
				) {
					return prev;
				}
				if (!cameFromReplace || prunedByDoc) {
					const prevSnapshot = prev.activeOrdinals;
					const widthsSnapshot = widthsNext;
					queueMicrotask(() =>
						options.onChange?.(activeNext, widthsSnapshot, prevSnapshot)
					);
				}
				return { activeOrdinals: activeNext, widths: widthsNext };
			}
		},
		props: {
			decorations(state: EditorState) {
				const s = hrSplitPluginKey.getState(state);
				if (!s) return null;
				const enabled = options.enabled?.() ?? true;
				return buildLayout(state.doc, s.activeOrdinals, s.widths, enabled).decorations;
			},
			attributes(state: EditorState): Record<string, string> {
				const s = hrSplitPluginKey.getState(state);
				const enabled = options.enabled?.() ?? true;
				if (!s || !enabled || s.activeOrdinals.size === 0) return {};
				const { template } = buildLayout(state.doc, s.activeOrdinals, s.widths, enabled);
				const attrs: Record<string, string> = { class: 'tomboy-hr-split-active' };
				if (template) attrs.style = `grid-template-columns:${template};`;
				return attrs;
			},
			handleClick(view, pos, event) {
				if (options.enabled && !options.enabled()) return false;
				if (!(event.ctrlKey || event.metaKey)) return false;
				const doc = view.state.doc;
				const topIdx = topLevelIndexAtPos(doc, pos);
				if (topIdx < 0) return false;
				const ordinal = ordinalOfTopIndex(doc, topIdx);
				if (ordinal < 0) return false;
				event.preventDefault();
				view.dispatch(
					view.state.tr.setMeta(hrSplitPluginKey, { toggle: ordinal })
				);
				return true;
			}
		},
		view(view: EditorView) {
			// Masonry has no defined track height along the masonry axis,
			// so the divider element (a thin paragraph in its own grid
			// column) only renders at intrinsic height — a short stub.
			// We measure the tallest content column at runtime and expose
			// it as `--hr-split-divider-height` on view.dom; CSS binds
			// the divider's `height` to that variable.
			//
			// Writing the variable on view.dom (not on the divider element
			// itself) is critical. PM's DOMObserver ignores attribute
			// mutations whose nearest desc is the docView, so view.dom
			// mutations stay out of `readDOMChange`. Writing inline style
			// on the divider paragraph instead routes through PM's
			// mutation path and — combined with the ResizeObserver below —
			// produces a runaway feedback loop on toggle.
			//
			// Bail entirely when `grid-template-rows: masonry` is not
			// supported. Without masonry, `align-items: start` on the
			// container keeps stretching disabled (no feedback loop), but
			// the divider would still sit in a single shared row and our
			// computed height would inflate that row past anything sane.
			// Leaving the divider at intrinsic height keeps layout
			// stable; visually the split degrades to a stub.
			const masonrySupported =
				typeof CSS !== 'undefined' &&
				CSS.supports?.('grid-template-rows', 'masonry') === true;

			let ro: ResizeObserver | null = null;

			function syncDividerHeights(): void {
				if (!(options.enabled?.() ?? true)) return;
				const root = view.dom;
				const dividers = root.querySelectorAll<HTMLElement>(
					':scope > .tomboy-hr-split-divider'
				);
				if (!masonrySupported || dividers.length === 0) {
					if (root.style.getPropertyValue('--hr-split-divider-height')) {
						root.style.removeProperty('--hr-split-divider-height');
					}
					return;
				}

				// Sum offsetHeight per content track. Skip dividers (whose
				// height we're computing) and headers (identified by the
				// class attached in buildLayout — string-matching the inline
				// `grid-column:1 / -1` style is unreliable because the
				// browser reserializes inline styles).
				const heightByTrack = new Map<number, number>();
				for (const child of Array.from(root.children) as HTMLElement[]) {
					if (child.classList.contains('tomboy-hr-split-divider')) continue;
					if (child.classList.contains('tomboy-hr-split-header')) continue;
					// PM widget rows that span all columns (e.g. the date-arrow
					// row) are placed via `grid-column: 1 / -1` in CSS, not via
					// a node decoration. Skip them like headers — counting them
					// in column 1's height would inflate the divider.
					if (child.classList.contains('datelink-arrow-row')) continue;
					const track = parseInt(getComputedStyle(child).gridColumnStart, 10);
					if (!Number.isFinite(track) || track < 1) continue;
					heightByTrack.set(
						track,
						(heightByTrack.get(track) || 0) + child.offsetHeight
					);
				}

				let maxHeight = 0;
				for (const h of heightByTrack.values()) {
					if (h > maxHeight) maxHeight = h;
				}
				if (maxHeight <= 0) return;

				const targetStr = `${maxHeight}px`;
				// Guard: re-writing the same value still mutates the
				// style attribute and re-fires the ResizeObserver path.
				if (root.style.getPropertyValue('--hr-split-divider-height') !== targetStr) {
					root.style.setProperty('--hr-split-divider-height', targetStr);
				}
			}

			if (masonrySupported && typeof ResizeObserver !== 'undefined') {
				ro = new ResizeObserver(() => syncDividerHeights());
				ro.observe(view.dom);
			}

			queueMicrotask(syncDividerHeights);

			// --- Divider drag-to-resize ---------------------------------
			// Plain (non-Ctrl/Cmd) pointerdown on a `.tomboy-hr-split-divider`
			// starts a drag that adjusts the fr ratio of the two adjacent
			// content columns while preserving their sum (and the rest of
			// the columns). Ctrl/Cmd-click still toggles the divider on/off
			// via handleClick — we early-out before claiming the event.
			//
			// Live preview is driven by PM transactions (meta-only, no
			// docChanged), throttled to one per animation frame so the
			// pointermove rate doesn't flood the editor with redundant
			// state updates. On pointerup the onChange callback persists
			// the final ratio.
			interface DragState {
				dividerIdx: number;
				startWidths: number[];
				startLeftPx: number;
				startRightPx: number;
				startX: number;
				divider: HTMLElement;
				pointerId: number;
			}
			let drag: DragState | null = null;
			let rafHandle: number | null = null;
			let pendingWidths: number[] | null = null;

			function getRenderedTrackPx(): number[] {
				const cs = getComputedStyle(view.dom);
				const parts = cs.gridTemplateColumns.split(/\s+/);
				return parts.map(s => parseFloat(s));
			}

			function flushPending(): void {
				rafHandle = null;
				if (!pendingWidths || view.isDestroyed) return;
				const w = pendingWidths;
				pendingWidths = null;
				view.dispatch(view.state.tr.setMeta(hrSplitPluginKey, { resize: w }));
			}

			function onPointerMove(e: PointerEvent): void {
				if (!drag) return;
				e.preventDefault();
				const dx = e.clientX - drag.startX;
				const sumPx = drag.startLeftPx + drag.startRightPx;
				if (sumPx <= 0) return;
				const minPx = sumPx * MIN_COLUMN_FRACTION;
				const newLeftPx = Math.max(
					minPx,
					Math.min(sumPx - minPx, drag.startLeftPx + dx)
				);
				const newRightPx = sumPx - newLeftPx;
				const leftIdx = drag.dividerIdx;
				const rightIdx = leftIdx + 1;
				const sumFr = drag.startWidths[leftIdx] + drag.startWidths[rightIdx];
				const newLeftFr = (newLeftPx / sumPx) * sumFr;
				const newRightFr = sumFr - newLeftFr;
				const next = drag.startWidths.slice();
				next[leftIdx] = newLeftFr;
				next[rightIdx] = newRightFr;
				pendingWidths = next;
				if (rafHandle === null) {
					rafHandle = requestAnimationFrame(flushPending);
				}
			}

			function endDrag(e: PointerEvent): void {
				if (!drag) return;
				const finishing = drag;
				drag = null;
				view.dom.classList.remove('tomboy-hr-split-dragging');
				try {
					finishing.divider.releasePointerCapture(finishing.pointerId);
				} catch {
					// pointer already released (e.g. element detached) — ignore.
				}
				finishing.divider.removeEventListener('pointermove', onPointerMove);
				finishing.divider.removeEventListener('pointerup', endDrag);
				finishing.divider.removeEventListener('pointercancel', endDrag);
				// Flush any pending RAF dispatch so the final state matches
				// the user's last pointer position even if pointerup beats
				// the next frame.
				if (rafHandle !== null) {
					cancelAnimationFrame(rafHandle);
					rafHandle = null;
				}
				if (pendingWidths && !view.isDestroyed) {
					const w = pendingWidths;
					pendingWidths = null;
					view.dispatch(view.state.tr.setMeta(hrSplitPluginKey, { resize: w }));
				}
				// Swallow the click that the browser synthesizes after a
				// drag-style pointer interaction. Without this, the
				// subsequent click event could be interpreted by other
				// handlers (e.g. the autoLink mark) as a navigation.
				e.preventDefault();
				e.stopPropagation();
			}

			function onPointerDown(e: PointerEvent): void {
				if (!(options.enabled?.() ?? true)) return;
				// Only the primary mouse button / touch initiates resize.
				if (e.button !== 0 && e.pointerType === 'mouse') return;
				// Ctrl/Cmd is reserved for the toggle gesture (handleClick).
				if (e.ctrlKey || e.metaKey) return;
				const target = e.target as HTMLElement | null;
				if (!target) return;
				const divider = target.closest<HTMLElement>('.tomboy-hr-split-divider');
				if (!divider) return;
				if (divider.parentElement !== view.dom) return;
				const state = hrSplitPluginKey.getState(view.state);
				if (!state || state.activeOrdinals.size === 0) return;

				// Index of this divider among siblings (matches dividerIdx
				// emitted by computeGridStyles).
				const dividerEls = Array.from(
					view.dom.querySelectorAll<HTMLElement>(
						':scope > .tomboy-hr-split-divider'
					)
				);
				const dividerIdx = dividerEls.indexOf(divider);
				if (dividerIdx < 0) return;
				if (dividerIdx + 1 >= state.widths.length) return;

				// Read the rendered px widths of the two adjacent content
				// tracks. The grid template alternates content/divider, so
				// content column C sits at parsed-track index 2C (0-based).
				const trackPx = getRenderedTrackPx();
				const leftTrack = 2 * dividerIdx;
				const rightTrack = 2 * (dividerIdx + 1);
				const startLeftPx = trackPx[leftTrack];
				const startRightPx = trackPx[rightTrack];
				if (
					!Number.isFinite(startLeftPx) ||
					!Number.isFinite(startRightPx) ||
					startLeftPx <= 0 ||
					startRightPx <= 0
				) {
					return;
				}

				drag = {
					dividerIdx,
					startWidths: state.widths.slice(),
					startLeftPx,
					startRightPx,
					startX: e.clientX,
					divider,
					pointerId: e.pointerId
				};
				view.dom.classList.add('tomboy-hr-split-dragging');
				try {
					divider.setPointerCapture(e.pointerId);
				} catch {
					// Pointer capture is best-effort; if it fails the
					// pointermove listener attached to the divider below
					// will still fire because the pointer remains over the
					// element under typical drags.
				}
				divider.addEventListener('pointermove', onPointerMove);
				divider.addEventListener('pointerup', endDrag);
				divider.addEventListener('pointercancel', endDrag);
				// Stop PM from treating this pointerdown as a selection
				// gesture inside the divider paragraph.
				e.preventDefault();
				e.stopPropagation();
			}

			view.dom.addEventListener('pointerdown', onPointerDown);

			return {
				update(_view: EditorView, _prevState: EditorState) {
					queueMicrotask(syncDividerHeights);
				},
				destroy() {
					ro?.disconnect();
					ro = null;
					view.dom.removeEventListener('pointerdown', onPointerDown);
					if (drag) {
						drag.divider.removeEventListener('pointermove', onPointerMove);
						drag.divider.removeEventListener('pointerup', endDrag);
						drag.divider.removeEventListener('pointercancel', endDrag);
						drag = null;
					}
					if (rafHandle !== null) {
						cancelAnimationFrame(rafHandle);
						rafHandle = null;
					}
					pendingWidths = null;
				}
			};
		}
	});
}

export function getActiveOrdinals(state: EditorState): ReadonlySet<number> {
	const s = hrSplitPluginKey.getState(state);
	return s?.activeOrdinals ?? new Set();
}

export function getColumnWidths(state: EditorState): number[] {
	const s = hrSplitPluginKey.getState(state);
	return s?.widths.slice() ?? [1];
}
