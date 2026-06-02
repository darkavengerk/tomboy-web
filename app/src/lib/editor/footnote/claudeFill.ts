import type { AnthropicMessage } from '$lib/chatNote/buildClaudeMessages.js';

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
