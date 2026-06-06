/**
 * ProseMirror plugin that scans the doc for chart blocks (a paragraph whose
 * text is a valid chart header, optionally followed by a config list) and, for
 * each CHECKED (`[x]`) block, mounts a chart (or a Korean error card) as a
 * widget decoration right after the header. UNCHECKED (`[ ]`) blocks render
 * nothing — the user just sees the raw config list.
 *
 * Checked layout: the chart's own title already names the data, so the header
 * paragraph (checkbox + redundant `Chart:… 제목` text) AND the config list are
 * both hidden — the user sees only the chart. To keep the chart toggleable back
 * to text, the chart widget paints its own checkbox at the top-left corner;
 * clicking it flips the underlying `inlineCheckbox` atom to unchecked, which
 * re-reveals the header + config and removes the chart.
 *
 * Toggling: the header's checkbox is an `inlineCheckbox` atom node. Its own
 * NodeView toggles `checked` on click when visible (unchecked state); when the
 * chart is shown the header is hidden, so the in-chart checkbox is the toggle.
 * Either way the doc change re-runs `apply` here, which rebuilds decorations.
 *
 * Invariant: the document is never mutated by this plugin's STATE; the in-chart
 * checkbox dispatches its own transaction from the view (a user action).
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { findChartRegions, type ChartRegion } from './findChartRegions.js';
import { parseChartBlock } from '../../chart/parseChartBlock.js';
import { parseDataNote } from '../../chart/parseDataNote.js';
import { transformData } from '../../chart/transformData.js';
import { buildChartConfig } from '../../chart/buildChartConfig.js';
import {
	mountChart,
	destroyChart,
	renderErrorCard,
	type ChartHandle
} from '../../chart/renderChart.js';
import { findNoteByTitle, getNoteEditorContent } from '../../core/noteManager.js';

export const chartBlockPluginKey = new PluginKey<DecorationSet>('tomboyChartBlock');

function buildDecorations(doc: PMNode): DecorationSet {
	const regions = findChartRegions(doc);
	const decos: Decoration[] = [];
	for (const region of regions) {
		if (!region.checked) continue; // unchecked → show config text, no widget

		// The chart widget, anchored just AFTER the header paragraph (headerTo) so
		// that hiding the header node below does not also hide the widget DOM.
		decos.push(
			Decoration.widget(region.headerTo, (view) => renderChartWidget(region, view), {
				side: 1,
				// headerText carries the `[x]` marker + title; including it (plus the
				// anchor pos) rebuilds the widget when the block's text changes.
				key: `chart:${region.headerEndPos}:${region.headerText}`
			})
		);

		// Hide the header line itself — its `Chart:… 제목` text duplicates the chart's
		// own title. The in-chart checkbox (top-left) toggles the chart back off.
		decos.push(
			Decoration.node(region.headerFrom, region.headerTo, {
				class: 'tomboy-chart-header-hidden'
			})
		);

		// Hide the config list so the user sees the chart instead of the settings
		// (the spec's either/or). Unchecking re-reveals both header and config.
		if (region.configListFrom !== undefined && region.configListTo !== undefined) {
			decos.push(
				Decoration.node(region.configListFrom, region.configListTo, {
					class: 'tomboy-chart-config-hidden'
				})
			);
		}
	}
	return DecorationSet.create(doc, decos);
}

/**
 * Flip the chart's header checkbox to unchecked, removing the chart and
 * re-revealing the header + config text. Uses the region's captured checkbox
 * position, re-validating it against the live doc (and re-scanning the header
 * range as a fallback) so a stale position can't mutate the wrong node.
 */
function toggleChartOff(view: EditorView, region: ChartRegion): void {
	const { doc, tr } = view.state;
	let pos = region.checkboxPos;
	if (pos === undefined || doc.nodeAt(pos)?.type.name !== 'inlineCheckbox') {
		pos = undefined;
		doc.nodesBetween(region.headerFrom, region.headerTo, (node, p) => {
			if (pos === undefined && node.type.name === 'inlineCheckbox') pos = p;
		});
	}
	if (pos === undefined) return;
	view.dispatch(tr.setNodeAttribute(pos, 'checked', false));
}

/** Build the widget container and asynchronously fill it with a chart or error. */
function renderChartWidget(region: ChartRegion, view: EditorView): HTMLElement {
	const container = document.createElement('div');
	container.className = 'tomboy-chart-widget';
	container.contentEditable = 'false';

	// Top-left checkbox overlaid on the chart — the only visible toggle now that
	// the header is hidden. Checked = chart showing; unchecking turns it back to
	// the editable header + config text. Lives outside `chartHost` so the async
	// mount/error render (which clears chartHost) never wipes it.
	const toggle = document.createElement('input');
	toggle.type = 'checkbox';
	toggle.checked = true;
	toggle.className = 'tomboy-chart-toggle';
	toggle.title = '차트 끄기 (텍스트로 보기)';
	toggle.addEventListener('mousedown', (e) => e.preventDefault());
	toggle.addEventListener('change', () => toggleChartOff(view, region));
	container.appendChild(toggle);

	// The chart/error render target. mountChart + renderErrorCard clear this
	// node's innerHTML, so the toggle above (a sibling) survives.
	const chartHost = document.createElement('div');
	chartHost.className = 'tomboy-chart-host';
	container.appendChild(chartHost);

	let handle: ChartHandle | null = null;

	// The whole body is guarded: any failure — IndexedDB I/O (findNoteByTitle),
	// data-note parsing, transformData (throws on a missing column), or Chart.js
	// construction (mountChart) — routes to the error card. Without this terminal
	// catch a rejected I/O promise would escape as an unhandled rejection.
	void (async () => {
		try {
			const spec = parseChartBlock(region.headerText, region.configLines);
			if (!spec || !spec.dataNoteTitle) {
				renderErrorCard(chartHost, '데이터 노트 제목(DATA::)이 필요합니다');
				return;
			}
			// Snapshot the data note at mount time. Toggling / reopening the note
			// rebuilds the widget (key changes), which re-reads fresh data.
			const note = await findNoteByTitle(spec.dataNoteTitle);
			if (!note) {
				renderErrorCard(chartHost, `데이터 노트 '${spec.dataNoteTitle}'를 찾을 수 없습니다`);
				return;
			}
			const tables = parseDataNote(getNoteEditorContent(note));
			if (tables.length === 0) {
				renderErrorCard(chartHost, '데이터 노트에 csv/tsv 블록이 없습니다');
				return;
			}
			const data = transformData(spec, tables[0]);
			const config = buildChartConfig(spec, data);
			handle = await mountChart(chartHost, config, spec.height);
		} catch (err) {
			renderErrorCard(chartHost, err instanceof Error ? err.message : '차트를 그릴 수 없습니다');
		}
	})();

	// Clean up the Chart.js instance when ProseMirror removes the widget.
	const observer = new MutationObserver(() => {
		if (!container.isConnected) {
			destroyChart(handle);
			observer.disconnect();
		}
	});
	if (container.ownerDocument?.body) {
		observer.observe(container.ownerDocument.body, { childList: true, subtree: true });
	}
	return container;
}

export function createChartBlockPlugin(): Plugin<DecorationSet> {
	return new Plugin<DecorationSet>({
		key: chartBlockPluginKey,
		state: {
			init(_, { doc }): DecorationSet {
				return buildDecorations(doc);
			},
			apply(tr, old): DecorationSet {
				if (!tr.docChanged) return old.map(tr.mapping, tr.doc);
				return buildDecorations(tr.doc);
			}
		},
		props: {
			decorations(state): DecorationSet | undefined {
				return chartBlockPluginKey.getState(state);
			}
		}
	});
}
