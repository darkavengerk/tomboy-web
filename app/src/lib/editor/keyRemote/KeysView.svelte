<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { KeysNoteSpec } from './parseKeysNote.js';
	import { KeysWsClient, type KeysClientStatus } from './keysClient.js';
	import {
		getDefaultTerminalBridge,
		getTerminalBridgeToken
	} from '$lib/editor/terminal/bridgeSettings.js';

	type Props = { spec: KeysNoteSpec; guid: string; onedit: () => void };
	let { spec, guid, onedit }: Props = $props();

	const KEYS = [
		{ label: '🔊 볼륨 업', code: 24 },
		{ label: '🔉 볼륨 다운', code: 25 }
	];

	let status: KeysClientStatus = $state('connecting');
	let statusMessage = $state('');
	// code → 'ok' | 'err' 일시 피드백.
	let feedback: Record<number, 'ok' | 'err'> = $state({});
	let feedbackMsg = $state('');
	let client: KeysWsClient | null = null;
	const feedbackTimers = new Map<number, ReturnType<typeof setTimeout>>();

	function flash(code: number, kind: 'ok' | 'err', msg = ''): void {
		feedback = { ...feedback, [code]: kind };
		feedbackMsg = msg;
		const prev = feedbackTimers.get(code);
		if (prev) clearTimeout(prev);
		feedbackTimers.set(
			code,
			setTimeout(() => {
				const next = { ...feedback };
				delete next[code];
				feedback = next;
			}, 800)
		);
	}

	onMount(async () => {
		const bridge = await getDefaultTerminalBridge();
		if (!bridge) {
			status = 'error';
			statusMessage = '브릿지 URL이 설정되지 않았습니다. 설정에서 기본 브릿지를 입력하세요.';
			return;
		}
		const token = await getTerminalBridgeToken();
		if (!token) {
			status = 'error';
			statusMessage = '브릿지에 로그인하지 않았습니다. 설정 → 동기화 설정 → 터미널 브릿지에서 로그인하세요.';
			return;
		}
		client = new KeysWsClient({
			bridge,
			target: spec.sshTarget,
			token,
			callbacks: {
				onStatus: (s, info) => {
					status = s;
					if (info?.message) statusMessage = info.message;
				},
				onKeyOk: (code) => flash(code, 'ok'),
				onKeyError: (code, message) => flash(code, 'err', message)
			}
		});
		client.connect();
	});

	onDestroy(() => {
		for (const t of feedbackTimers.values()) clearTimeout(t);
		feedbackTimers.clear();
		client?.close();
		client = null;
	});

	// 볼륨은 여러 번 연타하는 키라 버튼을 응답 대기 동안 막지 않는다 — 항상
	// 활성 상태로 두고 누를 때마다 즉시 전송. 미연결/대기 상태의 전송은
	// keysClient.sendKey 가 안전하게 무시한다(소켓 미개방이면 throw 안 함).
	function press(code: number): void {
		client?.sendKey(code);
	}
</script>

<div class="keys-view">
	<div class="keys-header">
		<code class="target">{spec.raw}</code>
		<button class="edit-btn" onclick={onedit} title="편집 모드">✎ 편집</button>
	</div>

	{#if status !== 'ready'}
		<div class="banner" class:error={status === 'error'}>
			{statusMessage ||
				(status === 'connecting' ? '연결 중...' : status === 'closed' ? '연결 종료됨' : '')}
		</div>
	{/if}

	<div class="pad">
		{#each KEYS as k (k.code)}
			<button
				class="key-btn"
				class:ok={feedback[k.code] === 'ok'}
				class:err={feedback[k.code] === 'err'}
				onclick={() => press(k.code)}
			>
				<span>{k.label}</span>
				{#if feedback[k.code] === 'ok'}<span class="mark">✓</span>{/if}
				{#if feedback[k.code] === 'err'}<span class="mark">✗</span>{/if}
			</button>
		{/each}
	</div>

	{#if feedbackMsg}<div class="feedback-msg">{feedbackMsg}</div>{/if}
</div>

<style>
	.keys-view {
		display: flex;
		flex-direction: column;
		gap: clamp(0.75rem, 3vw, 1.25rem);
		padding: clamp(1rem, 4vw, 2rem);
	}
	.keys-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.target {
		font-size: clamp(0.8rem, 3vw, 1rem);
		color: #666;
		word-break: break-all;
	}
	.edit-btn {
		background: none;
		border: 1px solid #ccc;
		border-radius: 6px;
		padding: 0.3rem 0.6rem;
		cursor: pointer;
	}
	.banner {
		padding: 0.6rem 0.8rem;
		border-radius: 8px;
		background: #f0f0f0;
		color: #444;
		font-size: 0.9rem;
	}
	.banner.error {
		background: #fdecea;
		color: #b3261e;
	}
	.pad {
		display: grid;
		grid-template-columns: 1fr;
		gap: clamp(0.75rem, 3vw, 1.25rem);
	}
	.key-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		min-height: clamp(3.5rem, 14vw, 5rem);
		font-size: clamp(1.1rem, 4.5vw, 1.5rem);
		border: 2px solid #ccc;
		border-radius: 14px;
		background: #fff;
		cursor: pointer;
		transition: background 0.15s, border-color 0.15s;
	}
	.key-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.key-btn.ok {
		border-color: #2e7d32;
		background: #e8f5e9;
	}
	.key-btn.err {
		border-color: #b3261e;
		background: #fdecea;
	}
	.mark {
		font-weight: 700;
	}
	.feedback-msg {
		font-size: 0.85rem;
		color: #b3261e;
		text-align: center;
	}
</style>
