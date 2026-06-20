/**
 * 노트종류 카탈로그 — 생성 다이얼로그의 드롭다운/스캐폴드/도움말의 단일 출처.
 * 순수 모듈(저장소 접근 없음). 각 parser 가 인식하는 최소 형식과 일치시킨다.
 *
 * trigger:
 *   'title-prefix'   — 타이틀 앞에 접두어를 붙여 인식 (자동화:: 등)
 *   'body-signature' — 본문 첫 보이는 줄(노트-content 2번째 줄) 시그니처 (ssh:// 등)
 *   'structural'     — 본문 구조로 인식 (일정 노트). 스캐폴드 없음.
 *   'plain'          — 일반 노트(기본값).
 */
export interface NoteTypeSpec {
	id: string;
	label: string;
	trigger: 'title-prefix' | 'body-signature' | 'structural' | 'plain';
	/** title-prefix 타입의 타이틀 접두어. */
	titlePrefix?: string;
	/** body-signature 타입의 본문 첫 줄 시그니처(스캐폴드). */
	bodySignature?: string;
	/** 팝업 안내 + 예시(한국어). */
	help: string;
}

export const NOTE_TYPES: NoteTypeSpec[] = [
	{ id: 'plain', label: '일반 노트', trigger: 'plain', help: '평범한 노트입니다.' },
	{
		id: 'terminal', label: '터미널 (SSH)', trigger: 'body-signature',
		bodySignature: 'ssh://user@host',
		help: '본문 첫 줄을 ssh://[user@]host[:port] 로 두면 터미널이 열립니다. 예: ssh://pi@192.168.0.5'
	},
	{
		id: 'keys', label: '키 이벤트', trigger: 'body-signature',
		bodySignature: 'keys://user@host',
		help: '본문 첫 줄을 keys://[user@]host[:port] 로 두면 키 이벤트 전송 노트가 됩니다.'
	},
	{
		id: 'chat-ollama', label: '채팅 (Ollama)', trigger: 'body-signature',
		bodySignature: 'llm://qwen2.5-coder:3b',
		help: '본문 첫 줄 llm://<model> + Q:/A: 턴으로 로컬 Ollama 와 대화합니다.'
	},
	{
		id: 'chat-claude', label: '채팅 (Claude)', trigger: 'body-signature',
		bodySignature: 'claude://',
		help: '본문 첫 줄 claude:// + Q:/A: 턴으로 Claude 와 대화합니다(구독 OAuth).'
	},
	{
		id: 'ocr', label: 'OCR', trigger: 'body-signature',
		bodySignature: 'ocr://claude',
		help: '본문 첫 줄 ocr://<model>. 이미지를 붙이면 원문 추출 + 번역이 채워집니다.'
	},
	{
		id: 'remarkable-wallpaper', label: '리마커블 배경화면', trigger: 'body-signature',
		bodySignature: 'remarkable://rm2',
		help: '본문 첫 줄 remarkable://<alias>. 리마커블 배경화면을 설정합니다.'
	},
	{
		id: 'automation', label: '데이터 자동화', trigger: 'title-prefix',
		titlePrefix: '자동화::',
		help: '타이틀 자동화::<command-id>. ⟳ 실행 버튼으로 데스크탑 명령을 돌리고 DATA:: 차트를 갱신합니다.'
	},
	{
		id: 'data', label: '데이터/차트', trigger: 'title-prefix',
		titlePrefix: 'DATA::',
		help: '타이틀 DATA::<project>. 본문의 ```csv 펜스가 차트로 렌더됩니다.'
	},
	{
		id: 'tally', label: '집계 (투표/퀴즈)', trigger: 'title-prefix',
		titlePrefix: '집계::',
		help: '타이틀 집계::<제목>. 「질문 |중복가능|정답:N」 줄 + 보기 리스트로 익명 투표/퀴즈를 만듭니다(공유 노트북 필요).'
	},
	{
		id: 'music-extract', label: '음악 추출', trigger: 'title-prefix',
		titlePrefix: '음악추출::',
		help: '타이틀 음악추출::<이름>. 본문에 유튜브 URL 목록을 두면 ⟳ 로 mp3 추출합니다.'
	},
	{
		id: 'music', label: '음악 플레이리스트', trigger: 'title-prefix',
		titlePrefix: '음악::',
		help: '타이틀 음악::<이름>. 추출된 mp3 를 재생하는 플레이리스트입니다.'
	},
	{
		id: 'remarkable-upload', label: '리마커블 업로드', trigger: 'title-prefix',
		titlePrefix: '리마커블::',
		help: '타이틀 리마커블::<이름>. 📥 업로드 버튼으로 OCR 파이프라인에 수동 투입합니다.'
	},
	{
		id: 'schedule', label: '일정', trigger: 'structural',
		help: '본문에 N월 헤더 + 한글 날짜 리스트로 적으면 일정 노트가 됩니다(설정 → 알림에서 지정).'
	},
	{
		id: 'hue-master', label: '조명 (Hue)', trigger: 'title-prefix',
		titlePrefix: '조명::',
		help: '타이틀 조명::전체 = 마스터(전구·방 가져오기). 조명::<이름> = 전구 노트(light:) 또는 방 노트(room:). 방 노트는 체크박스로 조명 on/off, 라디오로 씬을 고릅니다. 설정 → Hue 에서 허브 먼저 연결.'
	},
	{
		id: 'slip', label: 'Slip-Box', trigger: 'title-prefix',
		titlePrefix: 'Slip-Box::',
		help: '[0] Slip-Box 노트북의 링크드리스트 노드. 이전:/다음: 으로 연결합니다.'
	}
];

const BY_ID = new Map(NOTE_TYPES.map((t) => [t.id, t]));

export function getNoteType(id: string): NoteTypeSpec | undefined {
	return BY_ID.get(id);
}

/** 사용자가 입력한 raw 타이틀에 타입 접두어를 적용한 최종 타이틀. */
export function composeTitle(typeId: string, rawTitle: string): string {
	const t = BY_ID.get(typeId);
	return t?.titlePrefix ? t.titlePrefix + rawTitle : rawTitle;
}

/** body-signature 타입이면 본문 첫 줄 시그니처, 아니면 undefined. */
export function bodyFirstLine(typeId: string): string | undefined {
	return BY_ID.get(typeId)?.bodySignature;
}
