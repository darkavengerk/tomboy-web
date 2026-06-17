<!--
  집계 노트 공유 진입점 — `/poll/<노트제목>`.

  제목(집계:: 접두 뗀 이름)으로 노트를 찾아 `/note/<guid>` 로 리다이렉트한다.
  게스트는 진입 직후 공개 노트 동기화가 아직 안 끝났을 수 있어, 노트가 IDB 에
  나타날 때까지 잠깐 폴링한다(최대 ~8초). 호스트는 첫 시도에 바로 풀린다.

  방문자(미로그인·게스트 이름 없음)는 레이아웃이 `/welcome?next=/poll/...` 로
  보내고, 이름 입력 후 이 URL 로 되돌아온다.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { getAllNotes, findNoteByTitle } from '$lib/storage/noteStore.js';
	import { isTallyTitle, tallyName } from '$lib/tally';
	import { mode } from '$lib/stores/guestMode.svelte.js';
	import { ensureGuestSignedIn } from '$lib/firebase/app.js';
	import {
		getCachedPublicConfig,
		discoverPublicConfigForGuest
	} from '$lib/sync/firebase/publicConfig.js';

	let status = $state<'resolving' | 'notfound'>('resolving');
	// SvelteKit 이 라우트 파라미터를 이미 디코드해 준다(중복 디코드 금지).
	const name = $derived(page.params.title ?? '');

	/** 이름 → 노트 guid. 정확 매치 우선, 실패 시 tallyName 스캔(접두 공백 등 흡수). */
	async function resolve(n: string): Promise<string | null> {
		const exact = await findNoteByTitle(`집계::${n}`);
		if (exact && !exact.deleted) return exact.guid;
		const all = await getAllNotes();
		const hit = all.find((x) => !x.deleted && isTallyTitle(x.title) && tallyName(x.title) === n);
		return hit?.guid ?? null;
	}

	onMount(async () => {
		const n = name;
		if (!n) {
			status = 'notfound';
			return;
		}
		// 게스트는 익명 로그인 + 공개설정 캐시를 먼저 보장한다. 안 그러면 노트가
		// 이미 IDB 에 있는 재방문에서 너무 빨리 /note 로 넘어가, note 페이지의
		// 게스트 게이트가 (아직 캐시 미스라) /notes 로 튕긴다.
		if (mode.value === 'guest') {
			try {
				await ensureGuestSignedIn();
				if (!getCachedPublicConfig()) await discoverPublicConfigForGuest();
			} catch {
				/* 부트스트랩 실패 → 아래 해석/대기로 진행 */
			}
		}
		// 게스트 첫 동기화 대기 — 20 × 400ms ≈ 8초.
		for (let attempt = 0; attempt < 20; attempt++) {
			const guid = await resolve(n);
			if (guid) {
				void goto(`/note/${guid}`, { replaceState: true });
				return;
			}
			await new Promise((r) => setTimeout(r, 400));
		}
		status = 'notfound';
	});
</script>

<svelte:head><title>{name || '집계'} — Tomboy</title></svelte:head>

<main class="poll-landing">
	{#if status === 'resolving'}
		<p class="msg">투표를 여는 중…</p>
		<p class="sub">「{name}」</p>
	{:else}
		<p class="msg">투표를 찾지 못했습니다.</p>
		<p class="sub">「{name}」 노트가 공유되어 있는지 주최자에게 확인하세요.</p>
		<button type="button" class="home-btn" onclick={() => goto('/notes')}>노트 목록</button>
	{/if}
</main>

<style>
	.poll-landing {
		max-width: 360px;
		margin: max(48px, 14vh) auto;
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
