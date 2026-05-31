import { Extension } from '@tiptap/core';

import {
	createFootnotePlugin,
	footnotePluginKey,
	type FootnotePluginOptions
} from './plugin.js';
import { buildInsertFootnoteTransaction } from './insertCommand.js';
import { FootnoteMarker } from './node.js';
import { pushToast } from '$lib/stores/toast.js';

export {
	findFootnoteMatches,
	findFootnoteAt,
	findFootnotePartner,
	getDefinitionPreviewText
} from './footnotes.js';
export type { FootnoteMatch } from './footnotes.js';
export { footnotePluginKey };
export type { FootnotePluginOptions, FootnotePluginState } from './plugin.js';
export { buildInsertFootnoteTransaction } from './insertCommand.js';
export type { InsertFootnoteResult } from './insertCommand.js';
export { FootnoteMarker } from './node.js';

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

/**
 * Plugin + command 묶음. `TomboyFootnote` 배열의 두 번째 요소.
 * `.configure({ onMissing })` 가 필요한 호출지는 이 Extension 을 직접
 * 임포트해서 `[FootnoteMarker, TomboyFootnoteExtension.configure({...})]`
 * 형태로 조립한다.
 */
export const TomboyFootnoteExtension = Extension.create<FootnotePluginOptions>({
	name: 'tomboyFootnote',
	addOptions() {
		return {
			onMissing: () => {}
		};
	},
	addProseMirrorPlugins() {
		return [createFootnotePlugin(this.options)];
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

/**
 * 각주 기능 번들 — 호출지에서 `...TomboyFootnote` 로 스프레드한다.
 *
 * 두 요소:
 * - `FootnoteMarker`: 스키마 노드 (atom inline)
 * - `TomboyFootnoteExtension`: 플러그인 + 커맨드
 *
 * 옵션 (`onMissing` 등) 을 줘야 하는 호출지는 배열을 직접 구성한다:
 * `[FootnoteMarker, TomboyFootnoteExtension.configure({ onMissing })]`
 */
export const TomboyFootnote = [FootnoteMarker, TomboyFootnoteExtension] as const;
