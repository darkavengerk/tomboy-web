import { Extension } from '@tiptap/core';

import {
	createFootnotePlugin,
	footnotePluginKey,
	type FootnotePluginOptions
} from './plugin.js';
import {
	createFootnoteCleanupPlugin,
	footnoteCleanupPluginKey
} from './cleanupPlugin.js';
import { buildInsertFootnoteTransaction } from './insertCommand.js';
import { pushToast } from '$lib/stores/toast.js';

export {
	findFootnoteMatches,
	findFootnoteAt,
	findFootnotePartner
} from './footnotes.js';
export type { FootnoteMatch } from './footnotes.js';
export { footnotePluginKey, footnoteCleanupPluginKey };
export type { FootnotePluginOptions, FootnotePluginState } from './plugin.js';
export { buildInsertFootnoteTransaction } from './insertCommand.js';
export type { InsertFootnoteResult } from './insertCommand.js';

const ABORT_TOAST: Record<'in-title' | 'inside-existing-marker', string> = {
	'in-title': '각주는 본문에서만 삽입할 수 있습니다',
	'inside-existing-marker': '기존 각주 안에서는 삽입할 수 없습니다'
};

declare module '@tiptap/core' {
	interface Commands<ReturnType> {
		tomboyFootnote: {
			/** 커서 위치에 새 각주 참조를 삽입하고 본문 끝에 정의 단락을 추가. */
			insertFootnote: () => ReturnType;
		};
	}
}

export const TomboyFootnote = Extension.create<FootnotePluginOptions>({
	name: 'tomboyFootnote',
	addOptions() {
		return {
			onMissing: () => {}
		};
	},
	addProseMirrorPlugins() {
		const getEditor = () => this.editor;
		return [
			createFootnotePlugin(this.options),
			createFootnoteCleanupPlugin(getEditor)
		];
	},
	addCommands() {
		return {
			insertFootnote:
				() =>
				({ state, dispatch }) => {
					const result = buildInsertFootnoteTransaction(state);
					if (!result.ok) {
						pushToast(ABORT_TOAST[result.reason], { kind: 'error' });
						return false;
					}
					if (dispatch) dispatch(result.tr);
					return true;
				}
		};
	}
});
