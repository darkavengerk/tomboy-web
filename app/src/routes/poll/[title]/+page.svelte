<!--
  집계 노트 키오스크 — `/poll/<노트제목>`.

  불특정 다수가 들어오는 공유 투표 전용 화면. 노트 본문(투표)만 보여준다 —
  제목 바·노트 메뉴·앱 네비게이션 없음(레이아웃에서 /poll 을 chromeless 처리).
  /note 로 리다이렉트하지 않고 이 페이지에서 직접 TallyNote 를 렌더한다.

  닉네임 입력(/welcome)은 건너뛴다 — 방문자는 레이아웃이 익명 게스트로 자동
  부팅(닉네임 '익명')시킨 뒤 이 페이지로 되돌린다. 투표 정체성은 Firebase 익명
  uid 라 표시 이름이 필요 없다.

  제목(집계:: 접두 뗀 이름) → 노트. 게스트 첫 공개동기화가 늦을 수 있어 노트가
  IDB 에 나타날 때까지 잠깐 폴링한다.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import type { JSONContent } from '@tiptap/core';
	import type { NoteData } from '$lib/core/note.js';
	import { getAllNotes, findNoteByTitle } from '$lib/storage/noteStore.js';
	import { getNoteEditorContent } from '$lib/core/noteManager.js';
	import { getNotebook } from '$lib/core/notebooks.js';
	import { isTallyTitle, tallyName, parseTallyNote, type TallySpec } from '$lib/tally';
	import TallyNote from '$lib/editor/tallyNote/TallyNote.svelte';
	import { mode } from '$lib/stores/guestMode.svelte.js';
	import { ensureGuestSignedIn } from '$lib/firebase/app.js';
	import {
		getCachedPublicConfig,
		discoverPublicConfigForGuest
	} from '$lib/sync/firebase/publicConfig.js';

	let status = $state<'resolving' | 'ready' | 'notfound'>('resolving');
	let note = $state<NoteData | null>(null);
	// SvelteKit 이 라우트 파라미터를 이미 디코드해 준다(중복 디코드 금지).
	const name = $derived(page.params.title ?? '');

	const spec = $derived.by<TallySpec | null>(() => {
		if (!note) return null;
		const content = getNoteEditorContent(note) as JSONContent;
		return parseTallyNote(content, note.title);
	});

	/** 게스트는 공개(공유 노트북) 노트만 볼 수 있다. */
	function isPublic(n: NoteData): boolean {
		const nb = getNotebook(n);
		if (!nb) return false;
		return (getCachedPublicConfig()?.sharedNotebooks ?? []).includes(nb);
	}

	/** 이름 → 노트. 정확 매치 우선, 실패 시 tallyName 스캔(접두 공백 흡수). */
	async function resolve(n: string): Promise<NoteData | null> {
		const exact = await findNoteByTitle(`집계::${n}`);
		if (exact && !exact.deleted) return exact;
		const all = await getAllNotes();
		return all.find((x) => !x.deleted && isTallyTitle(x.title) && tallyName(x.title) === n) ?? null;
	}

	onMount(async () => {
		const n = name;
		if (!n) {
			status = 'notfound';
			return;
		}
		// 게스트: 익명 로그인 + 공개설정 캐시 보장(이후 isPublic 판정에 필요).
		if (mode.value === 'guest') {
			try {
				await ensureGuestSignedIn();
				if (!getCachedPublicConfig()) await discoverPublicConfigForGuest();
			} catch {
				/* 부트스트랩 실패 → 아래 대기로 진행 */
			}
		}
		// 게스트 첫 동기화 대기 — 20 × 400ms ≈ 8초.
		for (let attempt = 0; attempt < 20; attempt++) {
			const found = await resolve(n);
			if (found && (mode.value !== 'guest' || isPublic(found))) {
				note = found;
				status = 'ready';
				return;
			}
			await new Promise((r) => setTimeout(r, 400));
		}
		status = 'notfound';
	});
</script>

<svelte:head><title>{name || '집계'} — Tomboy</title></svelte:head>

{#if status === 'ready' && spec && note}
	<div class="poll-kiosk">
		<TallyNote {spec} guid={note.guid} />
	</div>
{:else}
	<main class="poll-landing">
		{#if status === 'resolving'}
			<p class="msg">투표를 여는 중…</p>
			<p class="sub">「{name}」</p>
		{:else}
			<p class="msg">투표를 찾지 못했습니다.</p>
			<p class="sub">「{name}」 노트가 공유되어 있는지 주최자에게 확인하세요.</p>
			<button type="button" class="home-btn" onclick={() => goto('/')}>홈으로</button>
		{/if}
	</main>
{/if}

<style>
	.poll-kiosk {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}
	.poll-kiosk :global(.tally-root) {
		flex: 1 1 auto;
		min-height: 0;
	}
	.poll-landing {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 0 16px;
		text-align: center;
		color: var(--color-text, #111);
	}
	.msg {
		font-size: 1.1rem;
		font-weight: 600;
		margin: 0 0 6px;
	}
	.sub {
		font-size: 0.9rem;
		color: var(--color-text-secondary, #777);
		margin: 0 0 18px;
		word-break: break-all;
	}
	.home-btn {
		padding: 10px 18px;
		font-size: 0.95rem;
		font-weight: 600;
		border: 1px solid var(--color-border, #ccc);
		border-radius: 10px;
		background: var(--color-bg, #fff);
		color: inherit;
		cursor: pointer;
	}
</style>
