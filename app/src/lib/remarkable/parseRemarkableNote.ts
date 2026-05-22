import type { JSONContent } from '@tiptap/core';
import { matchSlotLabel, type RmSlotId } from './slots.js';

export interface RemarkableSlotEntry {
	slot: RmSlotId;
	imageUrl: string;
}

export interface RemarkableNoteSpec {
	/** `remarkable://<alias>` 시그니처의 호스트 별칭. */
	host: string;
	/** 인식된 (슬롯, 이미지URL) 쌍 — 슬롯당 첫 등장만. */
	slots: RemarkableSlotEntry[];
}

const SIGNATURE_RE = /^remarkable:\/\/([A-Za-z0-9._-]+)\s*$/;
// 탐욕적 매칭 — 후행 구두점은 벗기지 않는다. 실사용 URL은 링크 마크로
// 들어오거나(이미 깔끔) 붙여넣기되며, 후행 '.'/')'가 붙은 평문 URL은
// 그대로 저장된다(브릿지 페치 단계에서 실패로 드러남).
const URL_RE = /https?:\/\/[^\s]+/;

/**
 * 노트의 TipTap JSON을 리마커블 배경화면 스펙으로 파싱.
 *
 * 인식: `remarkable://<alias>` 시그니처가 content[1](노트 본문 2번째 줄)의
 * 첫 줄이어야 한다. content[0](1번째 줄)은 항상 자유로운 노트 제목 —
 * 파서가 건드리지 않는다. 시그니처가 2번째 줄에 없으면 null = 평범한 노트.
 *
 * 섹션: 시그니처 이후(3번째 줄~), 트림 텍스트가 알려진 라벨인 단락이 섹션을
 * 연다. 그 아래(다음 라벨 또는 문서 끝까지) 단락들에서 발견되는 첫 http(s)
 * URL이 그 슬롯의 이미지. 미인식 라벨·단락은 무시.
 */
export function parseRemarkableNote(
	doc: JSONContent | null | undefined
): RemarkableNoteSpec | null {
	if (!doc || doc.type !== 'doc' || !Array.isArray(doc.content)) return null;
	const blocks = doc.content;
	// 1번째 줄 = 제목, 2번째 줄 = 시그니처 — 최소 2개 블록 필요.
	if (blocks.length < 2) return null;

	// 시그니처는 정확히 2번째 블록(content[1])의 첫 줄이어야 한다.
	const sigLine = blockText(blocks[1]).split('\n')[0].trim();
	const m = SIGNATURE_RE.exec(sigLine);
	if (!m) return null;
	const sigIndex = 1;
	const host = m[1];

	const slots: RemarkableSlotEntry[] = [];
	const seen = new Set<RmSlotId>();
	let currentSlot: RmSlotId | null = null;

	for (let i = sigIndex + 1; i < blocks.length; i++) {
		const text = blockText(blocks[i]);
		const labelSlot = matchSlotLabel(text.trim());
		if (labelSlot) {
			currentSlot = labelSlot;
			continue;
		}
		if (currentSlot && !seen.has(currentSlot)) {
			const urlMatch = URL_RE.exec(text);
			if (urlMatch) {
				slots.push({ slot: currentSlot, imageUrl: urlMatch[0] });
				seen.add(currentSlot);
				currentSlot = null;
			}
		}
	}

	return { host, slots };
}

/** 단락 블록의 인라인 텍스트를 이어붙임; hardBreak → '\n'. 마크는 무시.
 *  parseOcrNote / parseTerminalNote 와 동일하게 paragraph 만 본다. */
function blockText(block: JSONContent): string {
	if (!block || block.type !== 'paragraph') return '';
	if (!Array.isArray(block.content)) return '';
	let out = '';
	for (const child of block.content) {
		if (child.type === 'text') out += child.text ?? '';
		else if (child.type === 'hardBreak') out += '\n';
	}
	return out;
}
