import {
	AGG_METHODS,
	CHART_HEADER_RE,
	DATA_NOTE_PREFIX,
	DEFAULT_HEIGHT,
	isChartType,
	type AggMethod,
	type ChartSpec,
	type ChartType
} from './chartSpec';

export interface ChartHeader {
	type: ChartType;
	title: string;
	checked: boolean;
}

/** Parse the first line. Returns null if it is not a valid chart header. */
export function parseChartHeader(line: string): ChartHeader | null {
	const m = CHART_HEADER_RE.exec(line.trim());
	if (!m) return null;
	const type = m[2].toLowerCase();
	if (!isChartType(type)) return null;
	return {
		type,
		title: m[3].trim(),
		checked: m[1].toLowerCase() === 'x'
	};
}

interface Token {
	checked: boolean | null; // null = no checkbox prefix
	key: string; // lowercased keyword before ':' or the bare keyword
	value: string; // text after ':' (trimmed), '' if none
	raw: string;
}

/**
 * Split a config line into tokens. We split on commas only where the next
 * chunk starts a new token — i.e., begins with `[` (checkbox) or matches
 * `keyword:` (key–value). This lets `y:매출, 비용` stay as one token while
 * `[x]곡선, [x]점표시` and `x축:월, y축:금액` are split normally.
 */
function tokenize(line: string): Token[] {
	// Split on commas that are immediately followed by a new-token boundary.
	// A new-token starts with optional whitespace then either '[' or 'key:'.
	// The key class allows a leading Hangul char so Korean-only keys (`묶기:`,
	// `방식:`, `높이:`) are split boundaries too — not just ASCII-led ones
	// (`x축:`, `y최소:`). A comma inside one value stays with its key.
	const chunks = line.split(/,(?=\s*(?:\[|[\w가-힣]+:))/);

	return chunks
		.map((chunk) => chunk.trim())
		.filter((chunk) => chunk.length > 0)
		.map((chunk): Token => {
			let checked: boolean | null = null;
			let rest = chunk;
			const cb = /^\[([ xX])\]\s*/.exec(chunk);
			if (cb) {
				checked = cb[1].toLowerCase() === 'x';
				rest = chunk.slice(cb[0].length);
			}
			const colon = rest.indexOf(':');
			if (colon >= 0) {
				return {
					checked,
					key: rest.slice(0, colon).trim().toLowerCase(),
					value: rest.slice(colon + 1).trim(),
					raw: rest
				};
			}
			return { checked, key: rest.trim().toLowerCase(), value: '', raw: rest };
		});
}

function num(value: string): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

function splitList(value: string): string[] {
	return value
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * Build a ChartSpec from the header line and the flattened config lines.
 * Category-label lines (범위, 축/표시 …) carry no recognized token and are ignored.
 */
export function parseChartBlock(headerLine: string, configLines: string[]): ChartSpec | null {
	const header = parseChartHeader(headerLine);
	if (!header) return null;

	const spec: ChartSpec = {
		type: header.type,
		title: header.title,
		checked: header.checked,
		dataNoteTitle: '',
		range: { kind: 'all' },
		stacked: false,
		smooth: false,
		showPoints: false,
		showValues: false,
		showLegend: true,
		height: DEFAULT_HEIGHT
	};

	for (const line of configLines) {
		const trimmed = line.trim();
		if (trimmed.startsWith(DATA_NOTE_PREFIX)) {
			spec.dataNoteTitle = trimmed;
			continue;
		}
		for (const t of tokenize(line)) {
			applyToken(spec, t);
		}
	}
	return spec;
}

function applyToken(spec: ChartSpec, t: Token): void {
	// range options carry a checkbox; only the checked one wins.
	if (t.key === 'all' && t.checked) {
		spec.range = { kind: 'all' };
		return;
	}
	if (t.key === 'last' && t.checked) {
		spec.range = { kind: 'last', n: num(t.value) };
		return;
	}
	if (t.key === 'first' && t.checked) {
		spec.range = { kind: 'first', n: num(t.value) };
		return;
	}
	if (t.checked === false) return; // unchecked toggle → ignore

	switch (t.key) {
		case 'x':
			if (t.value) spec.xColumn = t.value;
			return;
		case 'y':
			if (t.value) spec.yColumns = splitList(t.value);
			return;
		case '묶기': {
			const n = num(t.value);
			if (n) spec.bin = { count: n, method: spec.bin?.method ?? 'average' };
			return;
		}
		case '방식': {
			const method: AggMethod = AGG_METHODS[t.value] ?? 'average';
			spec.bin = { count: spec.bin?.count ?? 0, method };
			return;
		}
		case 'stacked':
			spec.stacked = true;
			return;
		case '곡선':
			spec.smooth = true;
			return;
		case '점표시':
			spec.showPoints = true;
			return;
		case '점크기':
			spec.pointRadius = num(t.value);
			return;
		case '색상':
			spec.colors = splitList(t.value);
			return;
		case '팔레트':
			spec.palette = t.value;
			return;
		case '범례':
			spec.showLegend = true;
			return;
		case '값표시':
			spec.showValues = true;
			return;
		case 'x축':
			spec.xAxisLabel = t.value;
			return;
		case 'y축':
			spec.yAxisLabel = t.value;
			return;
		case 'y최소':
			spec.yMin = num(t.value);
			return;
		case 'y최대':
			spec.yMax = num(t.value);
			return;
		case '높이': {
			const n = num(t.value);
			if (n) spec.height = n;
			return;
		}
		default:
			return; // unknown token / category label → ignore
	}
}
