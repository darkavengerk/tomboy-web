import type { AnthropicMessage } from '$lib/chatNote/buildClaudeMessages.js';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { sendClaude, ClaudeChatError } from '$lib/chatNote/backends/claude.js';
import {
	getDefaultTerminalBridge,
	getTerminalBridgeToken
} from '$lib/editor/terminal/bridgeSettings.js';
import {
	getClaudeDefaultModel,
	getClaudeDefaultEffort
} from '$lib/storage/appSettings.js';
import { pushToast } from '$lib/stores/toast.js';
import { markActive, markIdle, setFootnoteStep } from './claudePlugin.js';
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

/** 정의 칸 마커 뒤 텍스트를 새 텍스트로 교체(라벨로 재탐색해 위치 드리프트 무시). */
function replaceDefinitionText(view: EditorView, label: string, text: string): void {
	const loc = locateDefinition(view.state.doc, label);
	if (!loc) return;
	const tr = view.state.tr;
	if (loc.textTo > loc.textFrom) tr.delete(loc.textFrom, loc.textTo);
	if (text) tr.insertText(text, loc.textFrom);
	view.dispatch(tr);
}

/** 정의 칸 끝에 델타를 덧붙임(매 호출 재탐색). */
function appendDefinitionText(view: EditorView, label: string, delta: string): void {
	const loc = locateDefinition(view.state.doc, label);
	if (!loc) return;
	view.dispatch(view.state.tr.insertText(delta, loc.textTo));
}

/**
 * 각주 @claude 채우기 오케스트레이터.
 * 시작 → 잠금 + 원문 스냅샷 + 정의 비우기 → bridge 설정 →
 * sendClaude 스트리밍 → 완료 trim / 실패·중단 복원.
 */
export async function runFootnoteClaude(
	view: EditorView,
	label: string,
	instruction: string
): Promise<void> {
	const startLoc = locateDefinition(view.state.doc, label);
	if (!startLoc) return;
	const snapshot = startLoc.text;
	const context = buildFootnoteContext(view.state.doc, label);

	markActive(view, label);
	replaceDefinitionText(view, label, ''); // 정의 비우기
	setFootnoteStep(view, label, { kind: 'thinking', label: '생각 중…', body: '' });

	const restore = () => {
		replaceDefinitionText(view, label, stripTriggerForRestore(snapshot));
	};
	const finish = () => {
		setFootnoteStep(view, label, null);
		markIdle(view, label);
	};

	try {
		const [bridge, token] = await Promise.all([
			getDefaultTerminalBridge(),
			getTerminalBridgeToken()
		]);
		if (!bridge || !token) {
			restore();
			pushToast('Claude 서비스에 연결할 수 없습니다 (브릿지 미설정)', {
				kind: 'error'
			});
			return;
		}
		const [model, effort] = await Promise.all([
			getClaudeDefaultModel(),
			getClaudeDefaultEffort()
		]);
		const r = await sendClaude({
			url: `${bridge}/claude/chat`,
			token,
			body: {
				messages: buildFootnoteMessages(context, instruction),
				system: FOOTNOTE_SYSTEM_PROMPT,
				model: model || undefined,
				effort
			},
			onToken: (delta) => appendDefinitionText(view, label, delta),
			onStep: (step) => setFootnoteStep(view, label, step)
		});
		if (r.reason === 'abort') {
			restore();
		} else {
			const loc = locateDefinition(view.state.doc, label);
			const trimmed = (loc?.text ?? '').trim();
			if (trimmed) replaceDefinitionText(view, label, trimmed);
			else {
				restore();
				pushToast('Claude가 빈 응답을 보냈습니다', { kind: 'error' });
			}
		}
	} catch (err) {
		restore();
		pushToast(footnoteClaudeErrorMessage(err), { kind: 'error' });
	} finally {
		finish();
	}
}

/** ClaudeChatError 종류를 한국어 사용자 메시지로 변환(UI 문자열 한국어 불변식). */
function footnoteClaudeErrorMessage(err: unknown): string {
	if (!(err instanceof ClaudeChatError)) return 'Claude 연결 실패';
	switch (err.kind) {
		case 'unauthorized':
			return '인증 실패 — 설정에서 브릿지 재로그인';
		case 'service_unavailable':
			return '데스크탑 Claude 서비스 응답 없음';
		case 'rate_limited':
			return 'Claude 사용량 한도 도달. 잠시 후 재시도';
		case 'cli_failed':
			return 'claude 실행 실패';
		case 'bad_request':
			return '요청 형식 오류';
		case 'payload_too_large':
			return '노트가 너무 큼';
		default:
			return 'Claude 연결 실패. 재시도?';
	}
}
