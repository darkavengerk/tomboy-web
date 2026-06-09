import { Extension } from '@tiptap/core';
import { createSunoImportPlugin } from './sunoImportPlugin.js';

export const TomboySunoImport = Extension.create({
	name: 'tomboySunoImport',
	addProseMirrorPlugins() {
		return [createSunoImportPlugin()];
	}
});
export { createSunoImportPlugin, sunoImportPluginKey } from './sunoImportPlugin.js';
