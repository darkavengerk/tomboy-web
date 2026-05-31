/**
 * ProseMirror plugin that scans the doc for chart blocks (a paragraph whose
 * text is a valid chart header, optionally followed by a config list) and, for
 * each CHECKED (`[x]`) block, mounts a chart (or a Korean error card) as a
 * widget decoration right after the header. UNCHECKED (`[ ]`) blocks render
 * nothing — the user just sees the raw config list.
 *
 * Toggling: the header's checkbox is an `inlineCheckbox` atom node whose own
 * NodeView toggles `checked` on click (see inlineCheckbox/node.ts). That doc
 * change re-runs `apply` here, which rebuilds decorations — so the chart
 * appears/disappears automatically. This plugin does NOT handle the click
 * itself; it only reads the checked state and renders.
 *
 * Invariant: the document is never mutated by this plugin.
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
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

		// The chart widget, anchored just after the header line.
		decos.push(
			Decoration.widget(region.headerEndPos, () => renderChartWidget(region), {
				side: 1,
				// headerText carries the `[x]` marker + title; including it (plus the
				// anchor pos) rebuilds the widget when the block's text changes.
				key: `chart:${region.headerEndPos}:${region.headerText}`
			})
		);

		// Hide the config list so the user sees the chart instead of the settings
		// (the spec's either/or). The header — including its inlineCheckbox — stays
		// visible so the chart can be toggled back off.
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

/** Build the widget container and asynchronously fill it with a chart or error. */
function renderChartWidget(region: ChartRegion): HTMLElement {
	const container = document.createElement('div');
	container.className = 'tomboy-chart-widget';
	container.contentEditable = 'false';
	let handle: ChartHandle | null = null;

	// The whole body is guarded: any failure — IndexedDB I/O (findNoteByTitle),
	// data-note parsing, transformData (throws on a missing column), or Chart.js
	// construction (mountChart) — routes to the error card. Without this terminal
	// catch a rejected I/O promise would escape as an unhandled rejection.
	void (async () => {
		try {
			const spec = parseChartBlock(region.headerText, region.configLines);
			if (!spec || !spec.dataNoteTitle) {
				renderErrorCard(container, '데이터 노트 제목(DATA::)이 필요합니다');
				return;
			}
			// Snapshot the data note at mount time. Toggling / reopening the note
			// rebuilds the widget (key changes), which re-reads fresh data.
			const note = await findNoteByTitle(spec.dataNoteTitle);
			if (!note) {
				renderErrorCard(container, `데이터 노트 '${spec.dataNoteTitle}'를 찾을 수 없습니다`);
				return;
			}
			const tables = parseDataNote(getNoteEditorContent(note));
			if (tables.length === 0) {
				renderErrorCard(container, '데이터 노트에 csv/tsv 블록이 없습니다');
				return;
			}
			const data = transformData(spec, tables[0]);
			const config = buildChartConfig(spec, data);
			handle = await mountChart(container, config, spec.height);
		} catch (err) {
			renderErrorCard(container, err instanceof Error ? err.message : '차트를 그릴 수 없습니다');
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
