/**
 * 각주 마커 잔해 자동 정리 플러그인.
 *
 * 사용자가 [^N] 마커의 일부 ('[', '^', 라벨 일부, ']') 만 삭제하면 텍스트
 * 잔해 (예: '^1]', '[^1') 가 남는다. 이 플러그인은 매 트랜잭션 후 직전 doc
 * 의 마커들을 위치 매핑으로 추적해, 더 이상 유효한 [^N] 패턴이 아닌 자리에
 * 남은 텍스트를 통째로 제거한다.
 *
 * 규칙:
 *  - 추적 대상은 트랜잭션 직전(oldState) 에 존재하던 마커뿐. 사용자가 새로
 *    타이핑하는 '[^3' 같은 입력은 oldMatches 에 없어 손대지 않는다.
 *  - 마커 안에서 라벨이 변경돼도 패턴이 유효하면 (예: [^1] → [^12]) 통과.
 *  - 정의 단락의 마커가 부분 삭제되면 마커 잔해만 지우고 설명 텍스트는 보존.
 *  - IME 조합 중에는 동작 안 함 — 한글 조합 단계의 임시 invalid 상태가
 *    잘못 정리되는 사고 방지.
 *  - 자기 자신이 만든 트랜잭션은 meta 플래그로 식별해 재귀 호출에서 빠짐.
 */
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Mapping } from '@tiptap/pm/transform';
import type { Editor } from '@tiptap/core';

import { findFootnoteMatches } from './footnotes.js';

const VALID_MARKER_RE = /^\[\^[^\]\s]+\]$/;

export const footnoteCleanupPluginKey = new PluginKey('tomboyFootnoteCleanup');

export function createFootnoteCleanupPlugin(
	getEditor: () => Editor | undefined
): Plugin {
	return new Plugin({
		key: footnoteCleanupPluginKey,
		appendTransaction(transactions, oldState, newState) {
			if (!transactions.some((t) => t.docChanged)) return null;

			// 우리가 만든 트랜잭션 — 재귀 호출 차단.
			if (transactions.some((t) => t.getMeta(footnoteCleanupPluginKey))) {
				return null;
			}

			// IME 조합 중 스킵.
			const editor = getEditor();
			if (editor?.view?.composing) return null;

			// atomic 노드 마커 (Task 5 도입) 는 부분 삭제 불가능 — debris 가 생길 수 없으므로
			// 제외. Task 8 에서 이 플러그인 자체를 삭제하면 이 분기도 사라진다.
			const oldMatches = findFootnoteMatches(oldState.doc).filter(
				(m) => m.to - m.from > 1
			);
			if (oldMatches.length === 0) return null;

			const mapping = new Mapping();
			for (const t of transactions) mapping.appendMapping(t.mapping);

			// 각 oldMatch 를 매핑한 잔해 범위.
			//
			// bias: from 은 +1, to 는 -1 — 마커 *원본* 위치에 인접한 사용자
			// 삽입을 범위 밖으로 밀어내기 위함. 이 조합은 두 가지 이점:
			//   (a) 인접 마커 직후 새 마커가 삽입되는 케이스(예: insertCommand
			//       가 [^3] 끝에 [^4] 추가) 에서 [^3]의 to 가 [^4] 영역으로
			//       끌려가 [^3][^4] 전체를 잔해로 오인하는 사고 차단.
			//   (b) doc 내부의 큰 replaceWith (def-섹션 통째 재정렬, 페이스트,
			//       import 등) 의 경우 마커 *전체* 가 replaced range 안에 있어
			//       from > to 가 되어 자연스럽게 inverted range — 아래 filter
			//       에서 걸러짐.
			//
			// 인접/겹치는 범위는 하나로 묶어 valid 체크 — 두 마커가 한 번에
			// 잘리며 잔해 부분이 우연히 합쳐져 valid 패턴이 되는 케이스(예:
			// '[^1] X [^2]' 가운데를 한 번에 지워 '[^2]' 가 남는 상황) 를 잘못
			// 정리하지 않도록.
			const ranges = oldMatches
				.map((m) => ({
					from: mapping.map(m.from, 1),
					to: mapping.map(m.to, -1)
				}))
				.filter((r) => r.from < r.to)
				.sort((a, b) => a.from - b.from);

			const merged: { from: number; to: number }[] = [];
			for (const r of ranges) {
				const last = merged[merged.length - 1];
				if (last && last.to >= r.from) {
					last.to = Math.max(last.to, r.to);
				} else {
					merged.push({ from: r.from, to: r.to });
				}
			}

			const cleanupTr = newState.tr;
			let didDelete = false;
			// 내림차순 — 뒤에서 지우면 앞 위치가 안 어긋남.
			for (let i = merged.length - 1; i >= 0; i--) {
				const r = merged[i];
				const adjFrom = cleanupTr.mapping.map(r.from);
				const adjTo = cleanupTr.mapping.map(r.to);
				if (adjFrom >= adjTo) continue;

				const text = cleanupTr.doc.textBetween(adjFrom, adjTo);
				if (VALID_MARKER_RE.test(text)) continue; // 여전히/우연히 valid.

				cleanupTr.delete(adjFrom, adjTo);
				didDelete = true;
			}

			if (!didDelete) return null;
			cleanupTr.setMeta(footnoteCleanupPluginKey, true);
			return cleanupTr;
		}
	});
}
