export type RmSlotId = 'suspended' | 'starting' | 'poweroff' | 'rebooting' | 'batteryempty';

export interface RmSlotLabel {
	/** 노트에 타이핑하는 한글 섹션 라벨 (trailing `:` 제외). */
	label: string;
	slot: RmSlotId;
}

/**
 * `remarkable://` 노트가 인식하는 섹션 라벨 — 표시 순서대로.
 * 각 `slot` id는 브릿지 `bridge/src/remarkable.ts`의 `RM_SLOT_FILES` 키와
 * 반드시 일치해야 한다(번들 분리상 복제 — 한쪽만 바꾸면 안 됨).
 */
export const RM_SLOT_LABELS: RmSlotLabel[] = [
	{ label: '절전 중', slot: 'suspended' },
	{ label: '부팅 중', slot: 'starting' },
	{ label: '전원 꺼짐', slot: 'poweroff' },
	{ label: '재부팅 중', slot: 'rebooting' },
	{ label: '배터리 없음', slot: 'batteryempty' }
];

/**
 * 트림된 단락 텍스트를 알려진 섹션 라벨과 매칭. 단일 trailing `:`은 허용·제거.
 * 매칭 실패 시 null.
 */
export function matchSlotLabel(trimmed: string): RmSlotId | null {
	const core = trimmed.replace(/:\s*$/, '').trim();
	for (const entry of RM_SLOT_LABELS) {
		if (entry.label === core) return entry.slot;
	}
	return null;
}
