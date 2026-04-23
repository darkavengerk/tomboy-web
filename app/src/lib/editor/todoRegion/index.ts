import { Extension } from '@tiptap/core';

import {
	createTodoRegionPlugin,
	todoRegionPluginKey,
	type TodoRegionPluginOptions
} from './plugin.js';

export { findTodoRegions, pairTodoRegions, regionContainingPos } from './regions.js';
export type { TodoRegion, TodoRegionKind, TodoRegionList } from './regions.js';
export { moveTodoItem, insertTodoBlock } from './commands.js';
export { todoRegionPluginKey };
export type { TodoRegionPluginOptions };

export const TomboyTodoRegion = Extension.create<TodoRegionPluginOptions>({
	name: 'tomboyTodoRegion',
	addOptions() {
		return {
			onMove: () => {}
		};
	},
	addProseMirrorPlugins() {
		return [createTodoRegionPlugin(this.options)];
	}
});
