export { parseNoteBundles, clampHeightPct, DEFAULT_HEIGHT_PCT } from './parser.js';
export type { BundleSpec, BundleNode, BundleEntry, BundleKind } from './parser.js';
export {
	createNoteBundlePlugin,
	noteBundlePluginKey,
	writeBundleHeightPct,
	setBundleChecked
} from './noteBundlePlugin.js';
export type { NoteBundleOptions, StackController } from './noteBundlePlugin.js';
