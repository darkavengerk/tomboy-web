<script lang="ts">
	import { getDiaryTriggerUrl, getDiaryTriggerToken } from '$lib/storage/appSettings.js';
	import {
		fetchPipelineConfig,
		savePipelineConfig,
		type PipelineFolderConfig
	} from '$lib/admin/remarkablePipeline.js';
	import { pushToast } from '$lib/stores/toast.js';

	let url = $state('');
	let token = $state('');
	let loading = $state(false);
	let saving = $state(false);
	let loaded = $state(false);
	let errorText = $state('');
	let defaultPrompt = $state('');
	let folders = $state<PipelineFolderConfig[]>([]);
	let mounted = $state(false);

	$effect(() => {
		if (mounted) return;
		mounted = true;
		void load();
	});

	async function load() {
		url = await getDiaryTriggerUrl();
		token = await getDiaryTriggerToken();
		if (!url || !token) {
			errorText = '트리거 URL/토큰이 설정되지 않았습니다. 관리자 → 리마커블에서 먼저 등록하세요.';
			return;
		}
		loading = true;
		errorText = '';
		const r = await fetchPipelineConfig(url, token);
		loading = false;
		if (!r.ok || !r.config) {
			errorText = r.error ?? '설정을 불러오지 못했습니다';
			return;
		}
		defaultPrompt = r.config.defaultPrompt;
		folders = r.config.folders;
		loaded = true;
	}

	function addFolder() {
		folders = [
			...folders,
			{ name: '', notebook: '', titleFormat: '{date} 리마커블([{unit_key}])', split: false, labels: [], prompt: '' }
		];
	}

	function removeFolder(i: number) {
		folders = folders.filter((_, idx) => idx !== i);
	}

	function labelsText(f: PipelineFolderConfig): string {
		return f.labels.join(', ');
	}
	function setLabels(i: number, text: string) {
		folders[i].labels = text.split(',').map((s) => s.trim()).filter(Boolean);
	}

	async function save() {
		if (!url || !token) return;
		saving = true;
		const r = await savePipelineConfig(url, token, { defaultPrompt, folders });
		saving = false;
		if (r.ok) pushToast('OCR 설정 저장됨');
		else pushToast(r.error ?? '저장 실패');
	}
</script>

<section class="diary-ocr">
	<h3>일기 OCR 파이프라인 설정</h3>
	<p class="info-text">
		리마커블 OCR의 폴더별 프롬프트와 라우팅을 편집합니다. 저장하면 데스크탑 trigger
		서버 경유로 <code>folders.yaml</code>에 기록됩니다.
	</p>

	{#if errorText}
		<p class="err">{errorText}</p>
	{/if}

	{#if loading}
		<p class="info-text">불러오는 중…</p>
	{:else if loaded}
		<label class="field">
			<span>기본 프롬프트 (폴더별 미지정 시 사용)</span>
			<textarea rows="4" bind:value={defaultPrompt}></textarea>
		</label>

		{#each folders as f, i (i)}
			<div class="folder-card">
				<div class="row">
					<label class="field grow">
						<span>폴더명 (rM CollectionType)</span>
						<input type="text" bind:value={f.name} placeholder="Diary" />
					</label>
					<button type="button" class="rm" onclick={() => removeFolder(i)}>삭제</button>
				</div>
				<div class="row">
					<label class="field grow">
						<span>노트북</span>
						<input type="text" bind:value={f.notebook} />
					</label>
					<label class="field grow">
						<span>제목 형식</span>
						<input type="text" bind:value={f.titleFormat} />
					</label>
				</div>
				<div class="row">
					<label class="chk">
						<input type="checkbox" bind:checked={f.split} /> 분할(슬립)
					</label>
					<label class="field grow">
						<span>라벨 (쉼표 구분)</span>
						<input type="text" value={labelsText(f)} oninput={(e) => setLabels(i, e.currentTarget.value)} />
					</label>
				</div>
				<label class="field">
					<span>프롬프트 (비우면 기본 프롬프트)</span>
					<textarea rows="3" bind:value={f.prompt}></textarea>
				</label>
			</div>
		{/each}

		<p class="warn">
			⚠️ 새 폴더는 태블릿 <code>diary-push.sh</code>의 <code>TARGET_FOLDERS</code>에도
			추가해야 페이지가 들어옵니다.
		</p>

		<div class="actions">
			<button type="button" onclick={addFolder}>폴더 추가</button>
			<button type="button" class="primary" onclick={save} disabled={saving}>
				{saving ? '저장 중…' : '저장'}
			</button>
		</div>
	{/if}
</section>

<style>
	.diary-ocr { display: flex; flex-direction: column; gap: 0.75rem; margin-top: 1.5rem; }
	.folder-card { border: 1px solid var(--border, #ddd); border-radius: 8px; padding: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem; }
	.row { display: flex; gap: 0.5rem; align-items: flex-end; }
	.field { display: flex; flex-direction: column; gap: 0.2rem; }
	.field.grow { flex: 1; }
	.field span { font-size: 0.8rem; opacity: 0.75; }
	textarea, input[type='text'] { width: 100%; box-sizing: border-box; }
	.chk { display: flex; align-items: center; gap: 0.3rem; white-space: nowrap; }
	.actions { display: flex; gap: 0.5rem; }
	.primary { font-weight: 600; }
	.rm { align-self: center; }
	.warn { font-size: 0.85rem; opacity: 0.85; }
	.err { color: var(--danger, #c0392b); }
</style>
