import type { NoteData } from '$lib/core/note.js';
import { parseChartBlock } from '$lib/chart/parseChartBlock.js';
import { parseDataNote } from '$lib/chart/parseDataNote.js';
import { transformData } from '$lib/chart/transformData.js';
import { buildChartConfig } from '$lib/chart/buildChartConfig.js';
import { mountChart, destroyChart } from '$lib/chart/renderChart.js';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';
import type { JsonChartRegion } from './findJsonChartRegions.js';

export interface ChartImage {
	/** `data:image/png;base64,…` URI ready to drop into pdfmake. */
	dataUri: string;
	/** Logical PDF width (page-relative pdfmake units). */
	width: number;
	/** Logical PDF height. */
	height: number;
}

/**
 * For each chart region in each note, look up its DATA note, build the
 * Chart.js config, render to an off-screen canvas, and capture a PNG dataURI.
 * Unchecked regions and regions whose DATA note isn't in the bundle return
 * null in the inner array — the converter just skips them.
 *
 * Caller is responsible for not calling this in non-browser contexts (no
 * `document`). The bundle send flow only runs in the browser today.
 */
/**
 * 입력은 노트별 CHECKED 차트 영역 목록 (호출자가 미리 필터). 출력은 같은
 * 순서의 (ChartImage | null) 배열 — pdfBundle 이 본문 안에서 i 번째 checked
 * 영역을 PNG 로 치환할 때 인덱스로 그대로 매칭한다. null 이면 그 위치는 차트
 * 치환을 건너뛰고 원본 paragraph + config list 가 그대로 남는다.
 */
export async function renderChartsToImages(
	regionsByGuid: Map<string, JsonChartRegion[]>,
	notesByTitle: Map<string, NoteData>
): Promise<Map<string, Array<ChartImage | null>>> {
	const out = new Map<string, Array<ChartImage | null>>();
	for (const [guid, regions] of regionsByGuid) {
		const images: Array<ChartImage | null> = [];
		let any = false;
		for (const region of regions) {
			const image = await renderOne(region, notesByTitle);
			images.push(image);
			if (image) any = true;
		}
		if (any) out.set(guid, images);
	}
	return out;
}

async function renderOne(
	region: JsonChartRegion,
	notesByTitle: Map<string, NoteData>
): Promise<ChartImage | null> {
	let spec;
	try {
		spec = parseChartBlock(region.headerText, region.configLines);
	} catch {
		return null;
	}
	if (!spec || !spec.dataNoteTitle) return null;

	const dataNote = notesByTitle.get(spec.dataNoteTitle);
	if (!dataNote) return null;

	let tables;
	try {
		const dataDoc = deserializeContent(dataNote.xmlContent);
		tables = parseDataNote(dataDoc);
	} catch {
		return null;
	}
	if (!tables || tables.length === 0) return null;

	let config;
	try {
		const data = transformData(spec, tables[0]);
		config = buildChartConfig(spec, data);
	} catch {
		// transformData throws on missing column — skip.
		return null;
	}

	// PDF 캡처용 옵션 오버라이드. 라이브 편집기에선 fade/grow 애니메이션이 그대로
	// 필요하지만 여기서는 mount 직후 한 프레임 뒤 캔버스를 toDataURL 로 떠야 하므로
	// 애니메이션을 끄지 않으면 라인 차트는 선이 baseline(y=0) 에 깔린 첫 프레임이,
	// bar 차트는 막대가 0 높이로 잡힌 프레임이 그대로 PNG 에 박힌다.
	//   - `animation: false` — 신축(scale) 애니메이션 비활성
	//   - `animations: {...}` — Chart.js v4 의 채널별 fallback (color/x/y)
	//   - `transitions.active` — 인터랙션 트랜지션(여기선 무관하지만 일관성)
	// responsive 는 그대로 켜둔다 — 끄면 캔버스가 HTML 기본 300×150 으로 잡혀
	// off-screen 컨테이너의 700px 폭이 안 반영된다.
	const captureConfig = {
		...config,
		options: {
			...config.options,
			animation: false,
			animations: { colors: false, x: false, y: false },
			transitions: { active: { animation: { duration: 0 } } }
		}
	};

	const container = createOffscreenContainer();
	try {
		const renderWidth = 700;
		const renderHeight = spec.height || 320;
		container.style.width = `${renderWidth}px`;
		const handle = await mountChart(container, captureConfig, renderHeight);
		if (!handle) return null;
		// Chart.js 는 construct 시점에 동기로 그리지만 일부 브라우저에서 캔버스 DOM
		// 스트로크가 다음 프레임에야 커밋되는 경우가 있어 한 틱 기다린다 — 애니메이션이
		// 꺼져 있으니 이 한 틱이 곧 완성된 차트.
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		const canvas = container.querySelector('canvas');
		if (!canvas) {
			destroyChart(handle);
			return null;
		}
		const dataUri = canvas.toDataURL('image/png');
		destroyChart(handle);
		// pdfmake-side dimensions: pageMargins are [40,50,40,50] on A4 = ~515pt
		// usable width. We keep the chart at 480pt to leave a bit of margin and
		// preserve the rendered aspect ratio.
		const aspect = renderHeight / renderWidth;
		const pdfWidth = 480;
		return { dataUri, width: pdfWidth, height: Math.round(pdfWidth * aspect) };
	} finally {
		container.remove();
	}
}

function createOffscreenContainer(): HTMLElement {
	const el = document.createElement('div');
	el.style.position = 'fixed';
	el.style.left = '-99999px';
	el.style.top = '0';
	el.style.pointerEvents = 'none';
	el.style.opacity = '0';
	document.body.appendChild(el);
	return el;
}
