import type { AnthropicMessage } from '$lib/chatNote/buildClaudeMessages.js';
import type { Node as PMNode } from '@tiptap/pm/model';
import { findFootnoteMatches, findFootnotePartner } from './footnotes.js';

/** 각주 설명 작성용 시스템 프롬프트. 글자수는 소프트(프롬프트) 유도. */
export const FOOTNOTE_SYSTEM_PROMPT =
	'너는 각주(footnote)를 작성하는 도우미다. 주어진 본문 맥락과 요청을 바탕으로, ' +
	'머리말이나 맺음말 없이 설명 본문만 출력한다. 반드시 한국어로, 300자 이내로 ' +
	'간결하게 작성한다. 마크다운 제목이나 목록 없이 자연스러운 문장으로 쓴다.';

/** 정의 칸 텍스트 끝의 `@claude <공백>` 트리거를 인식하고 지시문을 추출. */
export function extractTrigger(text: string): { instruction: string } | null {
	const m = /^([\s\S]*?)\s*@claude\s$/.exec(text);
	if (!m) return null;
	return { instruction: m[1].trim() };
}

/** 실패/중단 복원 시 끝 공백을 제거해 자동 재발화(@claude\s$ 재매치)를 막는다. */
export function stripTriggerForRestore(text: string): string {
	return text.replace(/\s+$/, '');
}

export interface DefLocation {
	/** footnoteMarker 노드의 절대 위치 (atom, nodeSize=1). */
	markerPos: number;
	/** 마커 뒤 텍스트 시작 (markerPos + 1). */
	textFrom: number;
	/** 정의 단락 내용 끝 (= 마커 뒤 텍스트 끝). */
	textTo: number;
	/** 마커 뒤 텍스트(= 단락 textContent, 마커는 atom이라 기여 안 함). */
	text: string;
}

/** 라벨에 해당하는 정의 마커 + 마커 뒤 텍스트 범위. 없으면 null. */
export function locateDefinition(doc: PMNode, label: string): DefLocation | null {
	const matches = findFootnoteMatches(doc);
	const def = matches.find((m) => m.isDefinitionMarker && m.label === label);
	if (!def) return null;
	const $after = doc.resolve(def.from + 1);
	const textTo = $after.end();
	return {
		markerPos: def.from,
		textFrom: def.from + 1,
		textTo,
		text: doc.textBetween(def.from + 1, textTo, '\n')
	};
}

/** 제목~짝 참조 마커 직전까지의 평문. 짝이 없으면 첫 정의 마커 직전까지 폴백. */
export function buildFootnoteContext(doc: PMNode, label: string): string {
	const matches = findFootnoteMatches(doc);
	const def = matches.find((m) => m.isDefinitionMarker && m.label === label);
	let cut: number;
	const partner = def ? findFootnotePartner(matches, def) : null;
	if (partner) {
		cut = partner.from;
	} else {
		const firstDef = matches.find((m) => m.isDefinitionMarker);
		cut = firstDef ? firstDef.from : doc.content.size;
	}
	return doc.textBetween(0, cut, '\n').trim();
}

/** `@claude <공백>` 로 끝나는 정의 단락만 label→instruction 맵으로 반환. */
export function definitionsMatchingTrigger(doc: PMNode): Map<string, string> {
	const out = new Map<string, string>();
	for (const m of findFootnoteMatches(doc)) {
		if (!m.isDefinitionMarker) continue;
		const $after = doc.resolve(m.from + 1);
		const text = doc.textBetween(m.from + 1, $after.end(), '\n');
		const trig = extractTrigger(text);
		if (trig) out.set(m.label, trig.instruction);
	}
	return out;
}

/** 컨텍스트 + 지시문을 단일 user 메시지로 조립. */
export function buildFootnoteMessages(
	context: string,
	instruction: string
): AnthropicMessage[] {
	const ask = instruction
		? `${context}\n\n[각주 요청] ${instruction}`
		: `${context}\n\n[각주 요청] 위 맥락에 맞는 각주 설명을 작성해줘.`;
	return [{ role: 'user', content: [{ type: 'text', text: ask }] }];
}
