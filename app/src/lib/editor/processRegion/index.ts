import { Extension } from '@tiptap/core';

import {
	createProcessRegionPlugin,
	processRegionPluginKey,
	type ProcessRegionPluginOptions
} from './plugin.js';

export { findProcessBlocks, findProcessItems, findProcessItemAt } from './regions.js';
export type {
	ProcessBlock,
	ProcessStage,
	ProcessStageList,
	ProcessItemRef,
	ProcessMoveDirection
} from './regions.js';
export { moveProcessItem, insertProcessBlock } from './commands.js';
export { processRegionPluginKey };
export type { ProcessRegionPluginOptions };

export const TomboyProcessRegion = Extension.create<ProcessRegionPluginOptions>({
	name: 'tomboyProcessRegion',
	addOptions() {
		return {
			onMove: () => {}
		};
	},
	addProseMirrorPlugins() {
		return [createProcessRegionPlugin(this.options)];
	}
});
