<script lang="ts">
	import { onMount } from 'svelte';
	import {
		isAuthenticated,
		startAuth,
		completeAuth,
		getNotesPath,
		setNotesPath
	} from '$lib/sync/dropboxClient.js';
	import {
		onSyncStatus,
		computePlan,
		applyPlan,
		type SyncStatus,
		type SyncResult,
		type SyncPlan,
		type PlanSelection
	} from '$lib/sync/syncManager.js';
	import { getManifest } from '$lib/sync/manifest.js';
	import SyncPlanView from '$lib/components/SyncPlanView.svelte';

	let authenticated = $state(false);
	let syncStatus: SyncStatus = $state('idle');
	let syncMessage = $state('');
	let lastSyncDate = $state('');
	let syncResult: SyncResult | null = $state(null);
	let processing = $state(false);
	let notesPath = $state('');
	let pathSaved = $state(false);
	let plan = $state<SyncPlan | null>(null);
	let planSelection = $state<PlanSelection | null>(null);
	let previewing = $state(false);

	onMount(() => {
		notesPath = getNotesPath();

		(async () => {
			// Check if we're returning from OAuth callback
			const urlParams = new URLSearchParams(window.location.search);
			const code = urlParams.get('code');
			if (code) {
				processing = true;
				const redirectUri = getRedirectUri();
				const success = await completeAuth(code, redirectUri);
				if (success) {
					authenticated = true;
					window.history.replaceState({}, '', '/settings');
				}
				processing = false;
			}

			authenticated = isAuthenticated();

			if (authenticated) {
				const manifest = await getManifest();
				if (manifest.lastSyncDate) {
					lastSyncDate = new Date(manifest.lastSyncDate).toLocaleString('ko-KR');
				}
			}
		})();

		const unsub = onSyncStatus((status, message) => {
			syncStatus = status;
			if (message) syncMessage = message;
		});

		return unsub;
	});

	function getRedirectUri(): string {
		return `${window.location.origin}/settings`;
	}

	async function handleConnect() {
		const redirectUri = getRedirectUri();
		await startAuth(redirectUri);
	}

	function handleSavePath() {
		setNotesPath(notesPath);
		notesPath = getNotesPath(); // read back normalized value
		pathSaved = true;
		setTimeout(() => (pathSaved = false), 2000);
	}

	async function handlePreview() {
		previewing = true;
		plan = null;
		planSelection = null;
		try {
			const p = await computePlan();
			const sel: PlanSelection = {
				download: new Set(p.toDownload.map((x) => x.guid)),
				upload: new Set(p.toUpload.map((x) => x.guid)),
				deleteRemote: new Set(p.toDeleteRemote.map((x) => x.guid)),
				deleteLocal: new Set(p.toDeleteLocal.map((x) => x.guid)),
				conflictChoice: new Map(p.conflicts.map((c) => [c.guid, c.suggested]))
			};
			plan = p;
			planSelection = sel;
		} catch (e) {
			syncResult = { status: 'error', uploaded: 0, downloaded: 0, deleted: 0, errors: [String(e)] };
		} finally {
			previewing = false;
		}
	}

	async function handleApplyPlan() {
		if (!plan || !planSelection) return;
		processing = true;
		syncResult = await applyPlan(plan, planSelection);
		plan = null;
		planSelection = null;
		if (syncResult.status === 'success') {
			const manifest = await getManifest();
			if (manifest.lastSyncDate) {
				lastSyncDate = new Date(manifest.lastSyncDate).toLocaleString('ko-KR');
			}
		}
		processing = false;
	}

</script>

<div class="settings-page">
	<main class="settings-content">
		<section class="section">
			<h2>동기화 폴더</h2>
			<div class="path-row">
				<input
					class="path-input"
					type="text"
					placeholder="/tomboy"
					bind:value={notesPath}
					onkeydown={(e) => e.key === 'Enter' && handleSavePath()}
				/>
				<button class="btn-save" onclick={handleSavePath}>
					{pathSaved ? '저장됨' : '저장'}
				</button>
			</div>
		</section>

		<section class="section">
			<h2>Dropbox 연동</h2>

			{#if processing}
				<div class="status-card">
					<span class="status-dot syncing"></span>
					<span>처리 중...</span>
				</div>
			{:else if authenticated}
				<div class="status-card">
					<span class="status-dot connected"></span>
					<span>Dropbox 연결됨</span>
				</div>

				<div class="sync-btns">
					<button class="btn btn-primary" onclick={handlePreview} disabled={syncStatus === 'syncing' || previewing}>
						{previewing ? '계산 중...' : '미리보기'}
					</button>
				</div>

				{#if plan && planSelection}
					<div class="plan-section">
						<SyncPlanView {plan} selection={planSelection} />
						<button class="btn btn-primary" onclick={handleApplyPlan} disabled={processing}>
							선택 항목 적용
						</button>
						<button class="btn btn-secondary" onclick={() => { plan = null; planSelection = null; }}>
							취소
						</button>
					</div>
				{/if}

				{#if syncStatus === 'syncing' && syncMessage}
					<div class="sync-progress">
						<span class="progress-dot"></span>
						<span>{syncMessage}</span>
					</div>
				{/if}

				{#if lastSyncDate}
					<p class="info-text">마지막 동기화: {lastSyncDate}</p>
				{/if}

				{#if syncResult}
					<div class="sync-result" class:error={syncResult.status === 'error'}>
						<p>업로드: {syncResult.uploaded} / 다운로드: {syncResult.downloaded} / 삭제: {syncResult.deleted}</p>
						{#if syncResult.errors.length > 0}
							<ul class="error-list">
								{#each syncResult.errors as err}
									<li>{err}</li>
								{/each}
							</ul>
						{/if}
					</div>
				{/if}

			{:else}
				<p class="info-text">Dropbox에 노트를 백업하고 동기화합니다.</p>
				<button class="btn btn-primary" onclick={handleConnect}>
					Dropbox 연결
				</button>
			{/if}
		</section>

	</main>
</div>

<style>
	.settings-page {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

.settings-content {
		flex: 1;
		overflow-y: auto;
		padding: 16px;
		padding-bottom: max(16px, var(--safe-area-bottom));
	}

	.section {
		margin-bottom: 32px;
	}

	.section h2 {
		font-size: 1rem;
		font-weight: 600;
		margin-bottom: 12px;
		color: var(--color-text);
	}

	.status-card {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px;
		background: var(--color-bg-secondary);
		border-radius: 8px;
		margin-bottom: 12px;
		font-size: 0.95rem;
	}

	.status-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.status-dot.connected {
		background: #2ecc71;
	}

	.status-dot.syncing {
		background: var(--color-primary);
		animation: pulse 1s infinite;
	}

	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	.btn {
		display: block;
		width: 100%;
		padding: 12px;
		border: none;
		border-radius: 8px;
		font-size: 1rem;
		font-weight: 600;
		margin-bottom: 12px;
	}

	.btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.btn-primary {
		background: var(--color-primary);
		color: white;
	}

	.btn-primary:active:not(:disabled) {
		background: var(--color-primary-dark);
	}

	.sync-btns {
		display: flex;
		gap: 8px;
		margin-bottom: 12px;
	}

	.sync-btns .btn {
		flex: 1;
		margin-bottom: 0;
	}

	.plan-section {
		margin-bottom: 16px;
		padding: 12px;
		border: 1px solid var(--color-border, #eee);
		border-radius: 8px;
	}

	.btn-secondary {
		background: transparent;
		color: var(--color-primary);
		border: 1px solid var(--color-primary);
	}

	.btn-secondary:active {
		background: #e8f0fe;
	}

	.info-text {
		font-size: 0.85rem;
		color: var(--color-text-secondary);
		margin-bottom: 12px;
	}

	.path-row {
		display: flex;
		gap: 8px;
		margin-bottom: 4px;
	}

	.path-input {
		flex: 1;
		padding: 10px 12px;
		border: 1px solid var(--color-border, #dee2e6);
		border-radius: 8px;
		font-size: 0.95rem;
		background: var(--color-bg);
		color: var(--color-text);
	}

	.btn-save {
		padding: 10px 16px;
		border: none;
		border-radius: 8px;
		background: var(--color-primary);
		color: white;
		font-size: 0.95rem;
		font-weight: 600;
		flex-shrink: 0;
	}

	.btn-save:active {
		background: var(--color-primary-dark);
	}

	.sync-progress {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		background: var(--color-bg-secondary);
		border-radius: 8px;
		margin-bottom: 12px;
		font-size: 0.85rem;
		color: var(--color-text-secondary);
	}

	.progress-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--color-primary);
		flex-shrink: 0;
		animation: pulse 1s infinite;
	}

	.sync-result {
		padding: 12px;
		background: #e8f5e9;
		border-radius: 8px;
		margin-bottom: 12px;
		font-size: 0.9rem;
	}

	.sync-result.error {
		background: #ffeef0;
	}

	.error-list {
		margin-top: 8px;
		padding-left: 16px;
		font-size: 0.8rem;
		color: var(--color-danger);
	}
</style>
