import { Extension } from '@tiptap/core';

import {
	createChecklistPlugin,
	checklistPluginKey,
	type ChecklistPluginOptions
} from './plugin.js';

export {
	isChecklistHeaderText,
	findChecklistRegions,
	findChecklistItems,
	findChecklistItemAt
} from './regions.js';
export type {
	ChecklistRegion,
	ChecklistRegionList,
	ChecklistItemRef
} from './regions.js';
export { checklistPluginKey };
export { toggleCheckboxAt, insertChecklistBlock } from './commands.js';
export type { ChecklistPluginOptions };

export const TomboyChecklist = Extension.create<ChecklistPluginOptions>({
	name: 'tomboyChecklist',
	addOptions() {
		return {
			onToggle: () => {}
		};
	},
	addProseMirrorPlugins() {
		return [createChecklistPlugin(this.options)];
	}
});
