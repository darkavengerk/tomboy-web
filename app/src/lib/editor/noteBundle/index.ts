export {
	parseNoteBundles,
	clampHeightPct,
	clampMaxCount,
	DEFAULT_HEIGHT_PCT,
	DEFAULT_MAX_COUNT,
	dedicatedBundleKind,
	parseDedicatedBundle,
	buildSyntheticBundleSpec
} from './parser.js';
export type { BundleSpec, BundleNode, BundleEntry, BundleKind } from './parser.js';
export {
	createNoteBundlePlugin,
	noteBundlePluginKey,
	writeBundleHeightPct,
	setBundleChecked,
	insertBundleListItemLink
} from './noteBundlePlugin.js';
export type { NoteBundleOptions, StackController } from './noteBundlePlugin.js';
