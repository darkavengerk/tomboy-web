import { PluginKey } from '@tiptap/pm/state';

/**
 * Shared PluginKeys for the HR feature family (split + fold).
 *
 * Both plugins need to read each other's state for mutual exclusion
 * (split active → fold buttons hidden; folded sections → split toggle
 * ignored). Keeping the keys in a standalone module avoids a circular
 * import between hrSplitPlugin.ts and hrFoldPlugin.ts.
 *
 * The generic parameter is intentionally left loose here; each plugin
 * module re-exports its own key with the concrete state type.
 */

export interface HrSplitPluginState {
	activeOrdinals: Set<number>;
	/** Per-column fr fractions, length = activeOrdinals.size + 1. */
	widths: number[];
}

export interface HrFoldPluginState {
	/** HR ordinals whose section (content below the HR) is folded. */
	folded: Set<number>;
}

export const hrSplitPluginKey = new PluginKey<HrSplitPluginState>('tomboyHrSplit');

export const hrFoldPluginKey = new PluginKey<HrFoldPluginState>('tomboyHrFold');
