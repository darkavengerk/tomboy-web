/**
 * listBox 가 손대면 안 되는 리스트 범위.
 *
 * 체크리스트: 영역과 프로세스 블록 스테이지 리스트는 각자의 의미론
 * (영역 데코레이션 / [[ ]] 마커)이 소유한다 — 그 안에서 항목 단위
 * boxKind 를 켜면 이중 위젯·마커 충돌이 나므로 입력 규칙과 데코
 * 플러그인 양쪽에서 제외한다. 아카이버 쪽 대응은
 * noteContentArchiver 의 allowItemMarkers / skip Set.
 */
import type { Node as PMNode } from '@tiptap/pm/model';

import { findChecklistRegions } from '../checklist/index.js';
import { findProcessBlocks } from '../processRegion/regions.js';

export interface ExcludedRange {
	from: number;
	to: number;
}

export function getExcludedListRanges(doc: PMNode): ExcludedRange[] {
	const out: ExcludedRange[] = [];
	for (const region of findChecklistRegions(doc)) {
		for (const list of region.lists) {
			out.push({ from: list.pos, to: list.pos + list.node.nodeSize });
		}
	}
	for (const block of findProcessBlocks(doc)) {
		for (const stage of block.stages) {
			for (const list of stage.lists) {
				out.push({ from: list.pos, to: list.pos + list.node.nodeSize });
			}
		}
	}
	return out;
}

export function posInExcludedList(
	ranges: ExcludedRange[],
	pos: number
): boolean {
	for (const r of ranges) {
		if (pos >= r.from && pos < r.to) return true;
	}
	return false;
}
