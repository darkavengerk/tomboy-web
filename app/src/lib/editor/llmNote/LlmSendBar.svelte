<script lang="ts">
	import type { Editor } from '@tiptap/core';
	import { onDestroy } from 'svelte';
	import { parseLlmNote } from '$lib/llmNote/parseLlmNote.js';
	import { buildChatRequest } from '$lib/llmNote/buildChatRequest.js';
	import { sendChat, LlmChatError } from '$lib/llmNote/sendChat.js';
	import { searchRag, RagSearchError, type RagHit } from '$lib/llmNote/searchRag.js';
	import { pushToast } from '$lib/stores/toast.js';

	type Props = {
		editor: Editor;
		bridgeUrl: string;
		bridgeToken: string;
	};

	let { editor, bridgeUrl, bridgeToken }: Props = $props();

	let abortController: AbortController | null = $state(null);
	let tokenCount = $state(0);
	let lastEditorVersion = $state(0);

	const onEditorUpdate = () => {
		lastEditorVersion = (lastEditorVersion + 1) | 0;
	};

	// Register the update listener reactively so Svelte tracks the closure
	// correctly — direct call at module scope would only capture the initial
	// `editor` value and generate a Svelte state_referenced_locally warning.
	$effect(() => {
		editor.on('update', onEditorUpdate);
		return () => {
			editor.off('update', onEditorUpdate);
		};
	});

	let spec = $derived.by(() => {
		lastEditorVersion; // subscribe to bump
		return parseLlmNote(editor.getJSON());
	});

	const sending = $derived(abortController !== null);

	const lastUserContent = $derived.by(() => {
		if (!spec || spec.messages.length === 0) return '';
		const last = spec.messages[spec.messages.length - 1];
		if (last.role !== 'user') return '';
		return last.content;
	});

	const sendDisabled = $derived(
		sending ||
			!spec ||
			!spec.trailingEmptyUserTurn ||
			lastUserContent.trim() === ''
	);

	function appendParagraph(text: string): void {
		const { state, view } = editor;
		const endPos = state.doc.content.size;
		const para = state.schema.nodes.paragraph.create(
			null,
			text === '' ? null : state.schema.text(text)
		);
		const tr = state.tr.insert(endPos, para);
		view.dispatch(tr);
	}

	function appendToLastParagraph(text: string): void {
		const { state, view } = editor;
		const endPos = state.doc.content.size;
		// Insert text right before the closing tag of the last paragraph.
		// endPos points after the last node; -1 puts us inside it.
		const insertPos = endPos - 1;
		const tr = state.tr.insertText(text, insertPos);
		view.dispatch(tr);
		try {
			view.dom.scrollTop = view.dom.scrollHeight;
		} catch { /* ignore */ }
	}

	async function send(): Promise<void> {
		if (sendDisabled || !spec) return;

		const body = buildChatRequest(spec);
		const ctrl = new AbortController();
		abortController = ctrl;
		tokenCount = 0;
		editor.setEditable(false);

		// Add empty A: paragraph as placeholder
		appendParagraph('A: ');

		// bridgeUrl 은 terminal note 용 WebSocket URL (wss://host/ws) 또는
		// 일반 base URL 일 수 있음. HTTP base 로 정규화:
		const httpBase = bridgeUrl
			.replace(/^wss:\/\//, 'https://')
			.replace(/^ws:\/\//, 'http://')
			.replace(/\/(ws|llm\/chat)\/?$/, '')
			.replace(/\/$/, '');

		// RAG retrieval (opt-in via rag header). On failure, fall through to
		// chat without context — RAG must never block a response.
		let retrievedNotes: RagHit[] = [];
		if (spec.options.rag && spec.options.rag > 0) {
			try {
				retrievedNotes = await searchRag({
					url: `${httpBase}/rag/search`,
					token: bridgeToken,
					query: lastUserContent,
					k: spec.options.rag,
					signal: ctrl.signal
				});
			} catch (err) {
				const e = err as RagSearchError;
				pushToast(`RAG 검색 실패 — 참고 노트 없이 응답 (${e.kind ?? 'unknown'})`);
			}
		}

		// Prepend retrieved bodies to system message (invisible to user)
		if (retrievedNotes.length > 0) {
			const ragPrefix =
				'참고 노트:\n' +
				retrievedNotes.map((n) => `## ${n.title}\n${n.body}`).join('\n\n---\n\n') +
				'\n\n---\n\n';
			if (body.messages.length > 0 && body.messages[0].role === 'system') {
				body.messages[0].content = ragPrefix + body.messages[0].content;
			} else {
				body.messages.unshift({ role: 'system', content: ragPrefix });
			}
		}

		try {
			const result = await sendChat({
				url: `${httpBase}/llm/chat`,
				token: bridgeToken,
				body,
				onToken: (delta) => {
					appendToLastParagraph(delta);
					tokenCount++;
				},
				signal: ctrl.signal
			});
			// Append 참고: [[title]] line on successful completion only (not abort)
			if (retrievedNotes.length > 0 && result.reason === 'done') {
				const titles = retrievedNotes.map((n) => `[[${n.title}]]`).join(' ');
				appendParagraph(`참고: ${titles}`);
			}
			appendParagraph('');
			appendParagraph('Q: ');
			const endPos = editor.state.doc.content.size;
			editor.commands.setTextSelection(endPos - 1);
			void result;
		} catch (err) {
			if (err instanceof LlmChatError) {
				let line: string;
				switch (err.kind) {
					case 'unauthorized':
						line = '[오류: 인증 실패]';
						pushToast('원격 브릿지 재인증 필요 — 설정 페이지에서 로그인');
						break;
					case 'model_not_found':
						line = `[오류: 모델 '${err.model ?? '?'}' 없음. ollama pull ${err.model ?? ''} 필요]`;
						break;
					case 'ollama_unavailable':
						line = '[오류: Ollama 서비스가 응답하지 않음]';
						break;
					case 'bad_request':
						line = `[오류: 요청 형식 오류 ${err.message ?? ''}]`;
						break;
					case 'upstream_error':
					case 'network':
					default:
						line = '[오류: 연결 실패. 재시도?]';
						break;
				}
				appendToLastParagraph(line);
				appendParagraph('');
				appendParagraph('Q: ');
			}
		} finally {
			abortController = null;
			editor.setEditable(true);
		}
	}

	function stop(): void {
		abortController?.abort();
	}

	function onKeyDown(e: KeyboardEvent): void {
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
			if (spec && !sendDisabled) {
				e.preventDefault();
				void send();
			}
		}
	}

	$effect(() => {
		const dom = editor.view.dom;
		dom.addEventListener('keydown', onKeyDown);
		return () => {
			dom.removeEventListener('keydown', onKeyDown);
		};
	});

	onDestroy(() => {
		abortController?.abort();
	});
</script>

{#if spec}
	<div class="llm-send-bar">
		{#if sending}
			<span class="tok-count">{tokenCount} tok</span>
			<button type="button" onclick={stop} class="stop">■ 중지</button>
		{:else}
			<button
				type="button"
				onclick={send}
				disabled={sendDisabled}
				title={sendDisabled && spec.trailingEmptyUserTurn === false
					? '보낼 질문이 없습니다'
					: ''}
				class="send"
			>
				보내기
			</button>
		{/if}
	</div>
{/if}

<style>
	.llm-send-bar {
		position: absolute;
		right: clamp(0.5rem, 2vw, 1.5rem);
		bottom: clamp(0.5rem, 2vw, 1.5rem);
		display: flex;
		gap: 0.5rem;
		align-items: center;
		padding: 0.4rem 0.6rem;
		background: var(--bg-elevated, #fff);
		border: 1px solid var(--border-color, #ccc);
		border-radius: 0.5rem;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
		z-index: 10;
		font-size: clamp(0.8rem, 1.6vw, 0.95rem);
	}
	button {
		padding: 0.3rem 0.8rem;
		border-radius: 0.3rem;
		border: 1px solid var(--border-color, #ccc);
		cursor: pointer;
		background: var(--bg-button, #f5f5f5);
	}
	button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	button.send {
		background: var(--accent, #3b82f6);
		color: white;
		border-color: var(--accent, #3b82f6);
	}
	button.stop {
		background: var(--danger, #dc2626);
		color: white;
		border-color: var(--danger, #dc2626);
	}
	.tok-count {
		font-variant-numeric: tabular-nums;
		opacity: 0.7;
	}
</style>
