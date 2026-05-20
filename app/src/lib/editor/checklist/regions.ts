/**
 * 체크리스트 영역 감지.
 *
 * "체크리스트:" 로 시작하는 최상위 문단(제목 줄 제외)이 헤더이고, 그 바로
 * 다음에 오는 1개 이상의 연속된 리스트 블록이 그 영역의 리스트가 된다.
 * 구조는 todoRegion/regions.ts 의 findTodoRegions 를 미러링한다.
 */
import type { Node as PMNode } from '@tiptap/pm/model';

/** "체크리스트:" 로 시작하면 true (콜론 필수, 앞뒤 공백 무시). */
export function isChecklistHeaderText(text: string): boolean {
	return /^체크리스트:/.test(text.trim());
}

export interface ChecklistRegionList {
	/** 리스트 노드의 절대 위치(여는 토큰). */
	pos: number;
	node: PMNode;
	/** 문서 최상위 자식 중 인덱스. */
	childIndex: number;
}

export interface ChecklistRegion {
	/** 헤더 문단 노드의 절대 위치. */
	headerPos: number;
	headerChildIndex: number;
	/** 영역을 이루는 연속 리스트 블록 (항상 >= 1). */
	lists: ChecklistRegionList[];
}

export function findChecklistRegions(doc: PMNode): ChecklistRegion[] {
	const regions: ChecklistRegion[] = [];
	const childCount = doc.childCount;
	if (childCount === 0) return regions;

	const positions: number[] = [];
	let offset = 0;
	doc.forEach((child) => {
		positions.push(offset);
		offset += child.nodeSize;
	});

	let i = 1; // 제목(0번) 건너뜀
	while (i < childCount) {
		const child = doc.child(i);
		if (child.type.name !== 'paragraph') {
			i++;
			continue;
		}
		if (!isChecklistHeaderText(child.textContent)) {
			i++;
			continue;
		}

		const lists: ChecklistRegionList[] = [];
		let j = i + 1;
		while (j < childCount) {
			const c = doc.child(j);
			// bulletList 만 영역 리스트로 본다. 아카이버(serializeContent)는
			// 최상위 orderedList 를 직렬화하지 않으므로, orderedList 를
			// 체크리스트로 취급하면 저장 시 내용이 사라진다.
			if (c.type.name === 'bulletList') {
				lists.push({ pos: positions[j], node: c, childIndex: j });
				j++;
			} else {
				break;
			}
		}

		if (lists.length > 0) {
			regions.push({
				headerPos: positions[i],
				headerChildIndex: i,
				lists
			});
			i = j;
		} else {
			i++;
		}
	}

	return regions;
}

/**
 * 영역 안의 모든 listItem (중첩 포함, 깊이 제한 없음).
 *
 * `contentStart` 는 항목 첫 문단의 내용 시작 위치 = liPos + 2
 * (listItem 여는 토큰 +1, 첫 문단 여는 토큰 +1). 첫 자식이 문단인
 * listItem 만 항목으로 본다 (정상 listItem 은 항상 그렇다).
 */
export interface ChecklistItemRef {
	/** listItem 노드의 절대 위치(여는 토큰 앞). */
	liPos: number;
	liNode: PMNode;
	/** 첫 문단 내용 시작 위치 = liPos + 2. */
	contentStart: number;
	checked: boolean;
}

export function findChecklistItems(
	regions: ChecklistRegion[]
): ChecklistItemRef[] {
	const items: ChecklistItemRef[] = [];
	for (const region of regions) {
		for (const list of region.lists) {
			collectChecklistItems(list.node, list.pos, items);
		}
	}
	return items;
}

function collectChecklistItems(
	listNode: PMNode,
	listPos: number,
	out: ChecklistItemRef[]
): void {
	// listPos 는 리스트 노드 위치 → +1 이 첫 listItem 위치.
	let offset = listPos + 1;
	listNode.forEach((li) => {
		if (li.type.name === 'listItem') {
			const liPos = offset;
			const firstChild = li.firstChild;
			if (firstChild && firstChild.type.name === 'paragraph') {
				out.push({
					liPos,
					liNode: li,
					contentStart: liPos + 2,
					checked: li.attrs?.checked === true
				});
			}
			// 이 listItem 안의 중첩 리스트로 재귀.
			let inLiOffset = liPos + 1;
			li.forEach((sub) => {
				// bulletList 만 — orderedList 는 아카이버가 직렬화하지 않는다.
				if (sub.type.name === 'bulletList') {
					collectChecklistItems(sub, inLiOffset, out);
				}
				inLiOffset += sub.nodeSize;
			});
		}
		offset += li.nodeSize;
	});
}

export function findChecklistItemAt(
	items: ChecklistItemRef[],
	liPos: number
): ChecklistItemRef | null {
	for (const it of items) {
		if (it.liPos === liPos) return it;
	}
	return null;
}
