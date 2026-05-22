/**
 * A top-level paragraph whose text forms a labeled divider — a divider
 * line with an embedded text label. Two layouts:
 *
 *   centered:  `-- label --`   2+ dashes on each side
 *   left:      `label ---`     3+ trailing dashes, no leading dashes
 *
 * Distinct from a plain `---` horizontal rule (handled by hrSplit): a
 * labeled divider always carries a real, non-dash label.
 */
export interface LabeledDivider {
	align: 'center' | 'left';
	/** The visible label text, exactly as it appears in the document. */
	label: string;
	/**
	 * Half-open `[start, end)` character ranges into the parsed string.
	 * `leadMark` and `trailMark` are the hidden markup runs. For centered
	 * layout each contains a dash run plus adjacent whitespace; for left
	 * layout leadMark (if present) is leading whitespace only. `labelRange`
	 * is the visible label. leadMark (if present) immediately precedes
	 * labelRange; labelRange immediately precedes trailMark. Together they
	 * are contiguous and tile the whole string. When leadMark is null,
	 * labelRange starts at 0. `leadMark` is null when there is no leading
	 * hidden run (the common `label ---` case).
	 */
	leadMark: readonly [number, number] | null;
	labelRange: readonly [number, number];
	trailMark: readonly [number, number];
}

// Centered: leading dash run, label, trailing dash run. `.+?` is minimal so
// the label never absorbs the surrounding whitespace (the greedy `\s*` in
// the adjacent groups claims it first).
const CENTERED = /^(\s*-{2,}\s*)(.+?)(\s*-{2,}\s*)$/;

// Left: optional leading whitespace, label, trailing dash run (3+).
const LEFT = /^(\s*)(.+?)(\s*-{3,}\s*)$/;

/** True when `s` contains a character that is neither dash nor whitespace. */
function hasRealChar(s: string): boolean {
	return /[^\s-]/.test(s);
}

/**
 * Classify `text` as a labeled divider. Returns `null` when it is not one
 * (including plain text and pure `---` horizontal rules).
 */
export function parseLabeledDivider(text: string): LabeledDivider | null {
	// Centered first: dashes-on-both-sides always wins over the left pattern.
	const centered = CENTERED.exec(text);
	if (centered) {
		const [, lead, label, trail] = centered;
		if (hasRealChar(label)) {
			const leadEnd = lead.length;
			const labelEnd = leadEnd + label.length;
			return {
				align: 'center',
				label,
				leadMark: [0, leadEnd],
				labelRange: [leadEnd, labelEnd],
				trailMark: [labelEnd, labelEnd + trail.length]
			};
		}
	}

	const left = LEFT.exec(text);
	if (left) {
		const [, lead, label, trail] = left;
		// Left layout is strictly "text then dashes" — reject a label that
		// itself starts with a dash so `- x ---`-style input stays plain.
		if (hasRealChar(label) && label[0] !== '-') {
			const leadEnd = lead.length;
			const labelEnd = leadEnd + label.length;
			return {
				align: 'left',
				label,
				leadMark: leadEnd > 0 ? [0, leadEnd] : null,
				labelRange: [leadEnd, labelEnd],
				trailMark: [labelEnd, labelEnd + trail.length]
			};
		}
	}

	return null;
}
