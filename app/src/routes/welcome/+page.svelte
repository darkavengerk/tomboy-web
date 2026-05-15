<script lang="ts">
	import { goto } from '$app/navigation';
	import { mode } from '$lib/stores/guestMode.svelte.js';
	import { startAuth } from '$lib/sync/dropboxClient.js';

	let name = $state('');
	let error = $state('');
	let busy = $state(false);

	async function submitGuest(e: SubmitEvent) {
		e.preventDefault();
		const v = name.trim();
		if (!v) {
			error = '이름을 입력해주세요.';
			return;
		}
		busy = true;
		mode.setGuestName(v);
		await mode.detectAndSet();
		void goto('/');
	}

	async function connectDropbox() {
		busy = true;
		const redirectUri = `${window.location.origin}/settings`;
		await startAuth(redirectUri);
	}
</script>

<svelte:head><title>환영합니다 — Tomboy</title></svelte:head>

<main class="welcome">
	<h1>Tomboy</h1>
	<p class="hint">공유된 노트북을 보려면 이름을 입력하세요.</p>

	<form onsubmit={submitGuest}>
		<input
			type="text"
			bind:value={name}
			placeholder="이름"
			maxlength="40"
			autocomplete="off"
			disabled={busy}
		/>
		<button type="submit" class="primary" disabled={busy}>게스트로 시작</button>
		{#if error}<p class="error">{error}</p>{/if}
	</form>

	<div class="sep"><span>또는</span></div>

	<button type="button" class="dbx" onclick={connectDropbox} disabled={busy}>
		Dropbox로 로그인
	</button>
</main>

<style>
	.welcome {
		max-width: 360px;
		margin: max(40px, 10vh) auto;
		padding: 0 16px;
		text-align: center;
		color: var(--color-text, #111);
	}
	h1 { font-size: 1.75rem; margin: 0 0 8px; }
	.hint { color: var(--color-text-secondary, #666); margin: 0 0 24px; }
	form { display: flex; flex-direction: column; gap: 10px; }
	input, button {
		padding: 12px 14px;
		font-size: 1rem;
		border-radius: 10px;
		box-sizing: border-box;
		width: 100%;
	}
	input {
		border: 1px solid var(--color-border, #ccc);
		background: var(--color-bg, #fff);
		color: inherit;
	}
	input:focus {
		outline: 2px solid var(--color-primary, #f57900);
		outline-offset: 1px;
	}
	button {
		border: none;
		cursor: pointer;
		font-weight: 600;
	}
	button:disabled { opacity: 0.55; cursor: default; }
	.primary { background: var(--color-primary, #f57900); color: white; }
	.dbx { background: #0061ff; color: white; }
	.error { color: #c00; font-size: 0.85rem; margin: 4px 0 0; }
	.sep {
		display: flex; align-items: center; gap: 8px;
		margin: 18px 0;
		color: var(--color-text-secondary, #888);
		font-size: 0.85rem;
	}
	.sep::before, .sep::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--color-border, #eee);
	}
</style>
