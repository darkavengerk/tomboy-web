/**
 * ProseMirror plugin that scans the doc for chart blocks (a paragraph whose
 * text is a valid chart header, optionally followed by a config list) and, for
 * each CHECKED (`[x]`) block, mounts a chart (or a Korean error card) as a
 * widget decoration right after the header. UNCHECKED (`[ ]`) blocks render
 * nothing — the user just sees the raw config list.
 *
 * Clicking the header's `[ ]`/`[x]` checkbox text toggles it, which flips the
 * widget on/off via the normal decoration rebuild.
 *
 * Invariant: the document is never mutated by rendering. The only doc change
 * this plugin makes is the explicit checkbox toggle dispatched on click.
 *
 * Note on `findChartRegions`: that module consumes a `JSONContent` tree (its
 * internal `sizeOf` reproduces ProseMirror positions from the JSON shape), so
 * we feed it `doc.toJSON()`. The positions it returns match the live document.
 */

import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { findChartRegions, type ChartRegion } from "./findChartRegions.js";
import { parseChartBlock } from "../../chart/parseChartBlock.js";
import { parseDataNote } from "../../chart/parseDataNote.js";
import { transformData } from "../../chart/transformData.js";
import { buildChartConfig } from "../../chart/buildChartConfig.js";
import {
	mountChart,
	destroyChart,
	renderErrorCard,
	type ChartHandle,
} from "../../chart/renderChart.js";
import { findNoteByTitle, getNoteEditorContent } from "../../core/noteManager.js";

export const chartBlockPluginKey = new PluginKey<DecorationSet>("tomboyChartBlock");

function buildDecorations(doc: PMNode): DecorationSet {
	// findChartRegions walks the JSON tree; its positions match the live doc.
	const regions = findChartRegions(doc.toJSON());
	const decos: Decoration[] = [];
	for (const region of regions) {
		if (!region.checked) continue; // unchecked → show config text, no widget
		decos.push(
			Decoration.widget(region.headerToPos, () => renderChartWidget(region), {
				side: 1,
				key: `chart:${region.headerFromPos}:${region.headerText}`,
			}),
		);
	}
	return DecorationSet.create(doc, decos);
}

/** Build the widget container and asynchronously fill it with a chart or error. */
function renderChartWidget(region: ChartRegion): HTMLElement {
	const container = document.createElement("div");
	container.className = "tomboy-chart-widget";
	container.contentEditable = "false";
	let handle: ChartHandle | null = null;

	void (async () => {
		const spec = parseChartBlock(region.headerText, region.configLines);
		if (!spec || !spec.dataNoteTitle) {
			renderErrorCard(container, "데이터 노트 제목(DATA::)이 필요합니다");
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
			renderErrorCard(container, "데이터 노트에 csv/tsv 블록이 없습니다");
			return;
		}
		try {
			// transformData throws on a missing column; mountChart (Chart.js) can
			// also throw at construction — both route to the error card.
			const data = transformData(spec, tables[0]);
			const config = buildChartConfig(spec, data);
			handle = await mountChart(container, config, spec.height);
		} catch (err) {
			renderErrorCard(
				container,
				err instanceof Error ? err.message : "차트를 그릴 수 없습니다",
			);
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

/** Toggle the header checkbox text [ ] <-> [x] at checkboxPos. */
function toggleHeaderCheckbox(view: EditorView, region: ChartRegion): void {
	const from = region.checkboxPos;
	const cur = view.state.doc.textBetween(from, from + 3); // "[ ]" or "[x]"
	const next = cur.toLowerCase() === "[x]" ? "[ ]" : "[x]";
	view.dispatch(view.state.tr.insertText(next, from, from + 3));
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
			},
		},
		props: {
			decorations(state): DecorationSet | undefined {
				return chartBlockPluginKey.getState(state);
			},
			handleClickOn(view, _pos, _node, _nodePos, event): boolean {
				// Toggle when the click lands on the header's checkbox text.
				const regions = findChartRegions(view.state.doc.toJSON());
				const clickPos = view.posAtCoords({
					left: (event as MouseEvent).clientX,
					top: (event as MouseEvent).clientY,
				});
				if (!clickPos) return false;
				for (const region of regions) {
					if (
						clickPos.pos >= region.checkboxPos &&
						clickPos.pos <= region.checkboxPos + 3
					) {
						toggleHeaderCheckbox(view, region);
						return true;
					}
				}
				return false;
			},
		},
	});
}
