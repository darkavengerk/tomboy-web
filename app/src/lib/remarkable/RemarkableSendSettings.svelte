<script lang="ts">
	import {
		getRemarkableSendDefault,
		setRemarkableSendDefault,
		clearRemarkableSendDefault,
		getAllRemarkableSendDefaults
	} from '$lib/storage/appSettings.js';
	import {
		getDefaultTerminalBridge,
		getTerminalBridgeToken,
		bridgeToHttpBase
	} from '$lib/editor/terminal/bridgeSettings.js';

	interface RemarkableFolder {
		uuid: string;
		visibleName: string;
		path: string;
		parent: string;
	}

	let alias = $state('');
	let folders = $state<RemarkableFolder[]>([]);
	let selectedUuid = $state('');
	let loading = $state(false);
	let errorText = $state('');
	let savedToast = $state(false);
	let mounted = $state(false);

	// 초기 prefill — 저장된 첫 번째 별칭이 있으면 그걸로 들어간다. 다중 alias 운영자는
	// alias 입력만 바꾸면 새 별칭 작업으로 넘어간다.
	$effect(() => {
		if (mounted) return;
		mounted = true;
		(async () => {
			const all = await getAllRemarkableSendDefaults();
			const first = Object.entries(all)[0];
			if (first) {
				alias = first[0];
				selectedUuid = first[1].folderUuid;
				folders = [
					{
						uuid: first[1].folderUuid,
						visibleName: first[1].folderName,
						path: `/${first[1].folderName}`,
						parent: ''
					}
				];
			}
		})();
	});

	async function fetchFolders(): Promise<void> {
		const a = alias.trim();
		if (!a) {
			errorText = '별칭을 먼저 입력하세요';
			return;
		}
		const bridge = await getDefaultTerminalBridge();
		const token = await getTerminalBridgeToken();
		if (!bridge || !token) {
			errorText = '브릿지 설정이 비어 있습니다 — 터미널 탭에서 먼저 등록하세요';
			return;
		}
		loading = true;
		errorText = '';
		try {
			const u = `${bridgeToHttpBase(bridge)}/remarkable/folders?alias=${encodeURIComponent(a)}&refresh=1`;
			const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				errorText = mapServerError(res.status, body.error);
				return;
			}
			const data = (await res.json()) as { folders?: RemarkableFolder[] };
			folders = data.folders ?? [];
			if (folders.length === 0) {
				errorText = '리마커블에 폴더가 없습니다 — 태블릿에서 폴더를 하나 만든 뒤 다시 시도';
			}
			// 기존에 저장된 폴더가 새 목록에 있으면 선택 유지.
			const existing = await getRemarkableSendDefault(a);
			if (existing && folders.some((f) => f.uuid === existing.folderUuid)) {
				selectedUuid = existing.folderUuid;
			} else if (!folders.some((f) => f.uuid === selectedUuid)) {
				selectedUuid = '';
			}
		} catch (err) {
			errorText = `네트워크 오류: ${(err as Error).message}`;
		} finally {
			loading = false;
		}
	}

	function mapServerError(status: number, err: string | undefined): string {
		if (status === 401) return '브릿지 인증 실패 — 토큰을 다시 발급하세요';
		if (err === 'remarkable_not_configured') {
			return '브릿지에 리마커블 호스트 설정이 없습니다 (remarkable.json)';
		}
		if (err === 'unknown_alias') return `별칭 '${alias.trim()}' 가 브릿지에 등록되어 있지 않습니다`;
		if (err === 'missing_alias') return '별칭을 입력하세요';
		if (err?.startsWith('remote_failure')) return `리마커블 접속 실패: ${err}`;
		return `폴더 조회 실패: ${err ?? `HTTP ${status}`}`;
	}

	async function save(): Promise<void> {
		const a = alias.trim();
		const folder = folders.find((f) => f.uuid === selectedUuid);
		if (!a || !folder) return;
		await setRemarkableSendDefault(a, {
			folderName: folder.visibleName,
			folderUuid: folder.uuid
		});
		savedToast = true;
		setTimeout(() => {
			savedToast = false;
		}, 2000);
	}

	async function clear(): Promise<void> {
		const a = alias.trim();
		if (!a) return;
		await clearRemarkableSendDefault(a);
		selectedUuid = '';
		savedToast = true;
		setTimeout(() => {
			savedToast = false;
		}, 2000);
	}
</script>

<section class="section">
	<h2>리마커블 PDF 송출</h2>
	<p class="info-text">
		노트를 PDF 로 변환해 리마커블 폴더에 보낼 때 쓸 기본 폴더를 별칭별로 지정합니다. 별칭은 브릿지
		<code>remarkable.json</code> 의 키와 같아야 합니다 (예: <code>rm2</code>).
	</p>

	<h3 class="field-label">리마커블 별칭</h3>
	<input
		class="path-input"
		type="text"
		placeholder="rm2"
		bind:value={alias}
		spellcheck="false"
		autocapitalize="off"
		autocomplete="off"
	/>

	<div class="path-row" style="margin-top: 0.75rem; gap: 0.5rem;">
		<button class="btn btn-secondary" onclick={fetchFolders} disabled={loading}>
			{loading ? '폴더 불러오는 중…' : '폴더 새로고침'}
		</button>
	</div>

	{#if errorText}
		<p class="info-text error-text">{errorText}</p>
	{/if}

	{#if folders.length > 0}
		<h3 class="field-label" style="margin-top: 1rem;">기본 폴더</h3>
		<select class="path-input" bind:value={selectedUuid}>
			<option value="">— 선택 —</option>
			{#each folders as f (f.uuid)}
				<option value={f.uuid}>{f.path}</option>
			{/each}
		</select>

		<div class="path-row" style="margin-top: 0.75rem; gap: 0.5rem;">
			<button class="btn-save" onclick={save} disabled={!selectedUuid}>
				{savedToast ? '저장됨' : '저장'}
			</button>
			<button class="btn btn-secondary" onclick={clear}>지우기</button>
		</div>
	{/if}
</section>

<style>
	.section {
		margin-bottom: 2rem;
	}
	h2 {
		margin: 0 0 0.5rem;
		font-size: 1.2rem;
	}
	.info-text {
		color: var(--text-muted, #666);
		font-size: 0.9rem;
		margin: 0.4rem 0;
	}
	.error-text {
		color: var(--error, #c44);
		margin-top: 0.75rem;
	}
	.field-label {
		margin: 0.6rem 0 0.3rem;
		font-size: 0.95rem;
		font-weight: 600;
	}
	.path-input {
		width: 100%;
		padding: 0.5rem;
		border: 1px solid var(--border, #ccc);
		border-radius: 4px;
		background: var(--bg, #fff);
		color: var(--text, #111);
		box-sizing: border-box;
	}
	.path-row {
		display: flex;
		align-items: center;
	}
	.btn,
	.btn-save {
		padding: 0.4rem 0.9rem;
		border: 1px solid var(--border, #ccc);
		border-radius: 4px;
		background: var(--bg-secondary, #f3f3f3);
		cursor: pointer;
	}
	.btn-save {
		background: var(--accent, #2a6);
		color: white;
		border-color: var(--accent, #2a6);
	}
	.btn:disabled,
	.btn-save:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
