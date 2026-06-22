import type { Component } from 'svelte';
import DiaryDetailView from './DiaryDetailView.svelte';

export interface DetailEntry {
	title: string;
	// 각 뷰는 `detail` prop(서비스별 shape)을 받는다.
	component: Component<{ detail: any }>;
}

/** 서비스키 → 상세 뷰. 후속 서비스는 여기 엔트리만 추가. */
export const DETAIL_REGISTRY: Record<string, DetailEntry> = {
	diary: { title: '📓 일기 파이프라인', component: DiaryDetailView }
};

/** 플러그인 버튼용 경량 목록(Svelte 컴포넌트 import 없이 키/라벨만). */
export const DETAIL_BUTTONS: Array<{ key: string; label: string }> = [
	{ key: 'diary', label: '📓 일기' }
];
