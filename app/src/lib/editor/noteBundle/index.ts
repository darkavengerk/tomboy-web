export { parseNoteBundles, clampHeightPct, DEFAULT_HEIGHT_PCT } from './parser.js';
export type { BundleSpec, BundleNode } from './parser.js';
export {
	createNoteBundlePlugin,
	noteBundlePluginKey,
	writeBundleHeightPct
} from './noteBundlePlugin.js';
export type { NoteBundleOptions, StackController } from './noteBundlePlugin.js';
