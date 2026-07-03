import type { ClaudeChatError } from './backends/claude.js';

/** claude-service imageInline의 oversize detail: "image too large: <bytes> bytes > <cap>" */
const TOO_LARGE_RE = /too large: (\d+) bytes > (\d+)/;

function mb(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * ClaudeChatError → 노트에 append할 한국어 오류 라인.
 *
 * ChatSendBar에서 추출 — image_fetch_failed는 서버가 보내준 사유(detail)를
 * 살려서 표시한다(크기 초과는 MB로 인간화). 과거엔 upstream_error로 뭉개져
 * "연결 실패"만 보여 원인 진단이 불가능했다.
 */
export function formatClaudeError(err: ClaudeChatError): string {
	switch (err.kind) {
		case 'unauthorized':
			return '[오류: 인증 실패 — 설정에서 브릿지 재로그인]';
		case 'service_unavailable':
			return '[오류: 데스크탑 Claude 서비스 응답 없음]';
		case 'rate_limited':
			return '[오류: Claude 사용량 한도 도달. 잠시 후 재시도]';
		case 'cli_failed':
			return `[오류: claude 실행 실패 — ${(err.detail ?? '').slice(0, 200)}]`;
		case 'bad_request':
			return `[오류: 요청 형식 오류 ${err.detail ?? ''}]`;
		case 'payload_too_large':
			return '[오류: 노트가 너무 큼]';
		case 'image_fetch_failed': {
			const m = TOO_LARGE_RE.exec(err.detail ?? '');
			if (m) {
				return `[오류: 이미지가 너무 큼 (${mb(Number(m[1]))} > ${mb(Number(m[2]))} 제한) — 이미지를 줄여 다시 시도]`;
			}
			return `[오류: 이미지 가져오기 실패 — ${(err.detail ?? '').slice(0, 120)}]`;
		}
		case 'network':
		case 'upstream_error':
		case 'stream_error':
		default:
			return '[오류: 연결 실패. 재시도?]';
	}
}
