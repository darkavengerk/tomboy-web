/**
 * Map a community ID to a CSS hsl() color. Uses the 137.5° golden angle
 * so adjacent IDs (e.g. 0 vs 1) are visually distinct, while same-ID
 * lookups are stable and deterministic.
 *
 * Negative or non-integer inputs are rounded and floored so the function
 * never panics on noise from upstream data.
 */
export function nodeColor(community: number): string {
	const n = Math.round(community);
	const hue = ((n * 137.5) % 360 + 360) % 360;
	return `hsl(${hue}, 60%, 55%)`;
}
