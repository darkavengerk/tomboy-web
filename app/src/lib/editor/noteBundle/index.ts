export {
	parseNoteBundles,
	clampHeightPct,
	clampMaxCount,
	DEFAULT_HEIGHT_PCT,
	DEFAULT_MAX_COUNT,
	DEFAULT_TAB_COUNT,
	dedicatedBundleKind,
	parseDedicatedBundle,
	buildSyntheticBundleSpec
} from './parser.js';
export type { BundleSpec, BundleNode, BundleEntry, BundleKind } from './parser.js';
export {
	createNoteBundlePlugin,
	noteBundlePluginKey,
	writeBundleHeightPct,
	setBundleChecked
} from './noteBundlePlugin.js';
export type { NoteBundleOptions, StackController } from './noteBundlePlugin.js';
