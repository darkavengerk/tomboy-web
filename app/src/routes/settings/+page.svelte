<script lang="ts">
	import { onMount } from 'svelte';
	import {
		isAuthenticated,
		startAuth,
		completeAuth,
		clearTokens,
		getNotesPath,
		setNotesPath,
		getSettingsPath,
		setSettingsPath,
		getImagesPath,
		setImagesPath
	} from '$lib/sync/dropboxClient.js';
	import {
		saveSettingsProfile,
		restoreSettingsProfile,
		listSettingsProfiles
	} from '$lib/sync/settingsSync.js';
	import {
		onSyncStatus,
		computePlan,
		applyPlan,
		type SyncStatus,
		type SyncResult,
		type SyncPlan,
		type PlanSelection,
		type SyncProgress
	} from '$lib/sync/syncManager.js';
	import { getManifest, clearManifest } from '$lib/sync/manifest.js';
	import { purgeAllLocal } from '$lib/storage/noteStore.js';
	import { sync } from '$lib/sync/syncManager.js';
	import { pushToast } from '$lib/stores/toast.js';
	import SyncPlanView from '$lib/components/SyncPlanView.svelte';

	type Tab = 'sync' | 'config' | 'advanced';
	let activeTab = $state<Tab>('sync');

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
	let syncProgress = $state<SyncProgress | null>(null);
	let previewing = $state(false);
	let resetting = $state(false);
	let resetConfirm = $state(false);

	let settingsPath = $state('');
	let settingsPathSaved = $state(false);
	let imagesPath = $state('');
	let imagesPathSaved = $state(false);
	let profileName = $state('default');
	let profiles = $state<string[]>([]);
	let selectedProfile = $state('');
	let savingProfile = $state(false);
	let restoringProfile = $state(false);
	let loadingProfiles = $state(false);
	let restoreConfirm = $state(false);

	onMount(() => {
		notesPath = getNotesPath();
		settingsPath = getSettingsPath();
		imagesPath = getImagesPath();

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
		// Clear prior progress and result so we start a fresh view
		syncProgress = null;
		syncResult = null;
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

	async function handleResetAndRedownload() {
		if (!resetConfirm) {
			resetConfirm = true;
			return;
		}
		resetting = true;
		try {
			await purgeAllLocal();
			await clearManifest();
			const r = await sync();
			if (r.status === 'success') {
				pushToast(`다시 받기 완료. 다운로드 ${r.downloaded}건.`);
				const manifest = await getManifest();
				if (manifest.lastSyncDate) {
					lastSyncDate = new Date(manifest.lastSyncDate).toLocaleString('ko-KR');
				}
			} else {
				pushToast('동기화 실패: ' + (r.errors[0] ?? '알 수 없는 오류'), { kind: 'error' });
			}
		} catch (e) {
			pushToast('초기화 실패: ' + String(e), { kind: 'error' });
		} finally {
			resetting = false;
			resetConfirm = false;
		}
	}

	function handleSaveSettingsPath() {
		setSettingsPath(settingsPath);
		settingsPath = getSettingsPath();
		settingsPathSaved = true;
		setTimeout(() => (settingsPathSaved = false), 2000);
	}

	function handleSaveImagesPath() {
		setImagesPath(imagesPath);
		imagesPath = getImagesPath();
		imagesPathSaved = true;
		setTimeout(() => (imagesPathSaved = false), 2000);
	}

	async function refreshProfiles() {
		loadingProfiles = true;
		try {
			profiles = await listSettingsProfiles();
			if (profiles.length > 0 && !profiles.includes(selectedProfile)) {
				selectedProfile = profiles[0];
			}
		} catch (e) {
			pushToast('프로필 목록을 불러오지 못했습니다: ' + String(e), { kind: 'error' });
		} finally {
			loadingProfiles = false;
		}
	}

	async function handleSaveProfile() {
		const name = profileName.trim();
		if (!name) {
			pushToast('프로필 이름을 입력하세요.', { kind: 'error' });
			return;
		}
		savingProfile = true;
		try {
			await saveSettingsProfile(name);
			pushToast(`'${name}' 프로필을 저장했습니다.`);
			await refreshProfiles();
			selectedProfile = name;
		} catch (e) {
			pushToast('프로필 저장 실패: ' + String(e), { kind: 'error' });
		} finally {
			savingProfile = false;
		}
	}

	async function handleRestoreProfile() {
		if (!selectedProfile) return;
		if (!restoreConfirm) {
			restoreConfirm = true;
			return;
		}
		restoringProfile = true;
		try {
			await restoreSettingsProfile(selectedProfile);
			pushToast(`'${selectedProfile}' 프로필을 내려받았습니다. 새로고침 후 적용됩니다.`);
			setTimeout(() => window.location.reload(), 800);
		} catch (e) {
			pushToast('프로필 내려받기 실패: ' + String(e), { kind: 'error' });
		} finally {
			restoringProfile = false;
			restoreConfirm = false;
		}
	}

	async function handleApplyPlan() {
		if (!plan || !planSelection) return;
		processing = true;
		syncResult = null;
		syncProgress = null;

		// Keep `plan` and `planSelection` set so the preview stays visible and
		// the per-row progress indicators can overlay onto it.
		const result = await applyPlan(plan, planSelection, (progress) => {
			syncProgress = progress;
		});
		syncResult = result;

		if (result.status === 'success') {
			const manifest = await getManifest();
			if (manifest.lastSyncDate) {
				lastSyncDate = new Date(manifest.lastSyncDate).toLocaleString('ko-KR');
			}
		}
		processing = false;
	}

	function clearPlan() {
		plan = null;
		planSelection = null;
		syncProgress = null;
		syncResult = null;
	}

	const tabs: { id: Tab; label: string }[] = [
		{ id: 'sync', label: '동기화' },
		{ id: 'config', label: '동기화 설정' },
		{ id: 'advanced', label: '고급' }
	];
</script>

<div class="settings-page">
	<nav class="settings-tabs" aria-label="설정 탭">
		{#each tabs as t (t.id)}
			<button
				type="button"
				class="tab"
				class:active={activeTab === t.id}
				aria-current={activeTab === t.id ? 'page' : undefined}
				onclick={() => (activeTab = t.id)}
			>
				{t.label}
			</button>
		{/each}
	</nav>

	<main class="settings-content">
		{#if activeTab === 'sync'}
			<!-- ── 동기화 탭 ───────────────────────────────────────────────── -->
			<section class="section">
				{#if processing && !plan}
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
						<button
							class="btn btn-primary"
							onclick={handlePreview}
							disabled={syncStatus === 'syncing' || previewing}
						>
							{previewing ? '계산 중...' : '미리보기'}
						</button>
					</div>

					{#if plan && planSelection}
						<div class="plan-section">
							<SyncPlanView {plan} selection={planSelection} progress={syncProgress} />
							{#if !syncProgress}
								<!-- Preview mode: apply or cancel -->
								<button class="btn btn-primary" onclick={handleApplyPlan} disabled={processing}>
									선택 항목 적용
								</button>
								<button class="btn btn-secondary" onclick={clearPlan}>
									취소
								</button>
							{:else if syncProgress.phase === 'done'}
								<!-- Done: summary below + close button -->
								<button class="btn btn-secondary clear-btn" onclick={clearPlan}>
									닫기
								</button>
							{:else}
								<!-- In progress -->
								<div class="sync-progress-line">
									<span class="progress-dot"></span>
									<span>{syncProgress.phaseLabel} 진행 중...</span>
								</div>
							{/if}
						</div>
					{/if}

					{#if syncStatus === 'syncing' && syncMessage && !syncProgress && !plan}
						<div class="sync-progress-line">
							<span class="progress-dot"></span>
							<span>{syncMessage}</span>
						</div>
					{/if}

					{#if syncResult}
						<div class="sync-result" class:error={syncResult.status === 'error'}>
							<p>
								업로드: {syncResult.uploaded} / 다운로드: {syncResult.downloaded} / 삭제: {syncResult.deleted}
							</p>
							{#if syncResult.errors.length > 0}
								<ul class="error-list">
									{#each syncResult.errors as err}
										<li>{err}</li>
									{/each}
								</ul>
							{/if}
						</div>
					{/if}

					{#if lastSyncDate}
						<p class="info-text">마지막 동기화: {lastSyncDate}</p>
					{/if}
				{:else}
					<div class="status-card">
						<span class="status-dot disconnected"></span>
						<span>Dropbox에 연결되어 있지 않습니다</span>
					</div>
					<p class="info-text">
						동기화를 시작하려면 Dropbox 계정에 먼저 연결해야 합니다.
					</p>
					<button class="btn btn-primary" onclick={handleConnect}>Dropbox 연결</button>
					<button class="btn btn-secondary" onclick={() => (activeTab = 'config')}>
						동기화 설정 열기
					</button>
				{/if}
			</section>
		{:else if activeTab === 'config'}
			<!-- ── 동기화 설정 탭 ──────────────────────────────────────────── -->
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
						<button
							class="btn-disconnect"
							onclick={() => {
								clearTokens();
								authenticated = false;
							}}
						>
							연결 끊기
						</button>
					</div>
				{:else}
					<p class="info-text">Dropbox에 노트를 백업하고 동기화합니다.</p>
					<button class="btn btn-primary" onclick={handleConnect}>Dropbox 연결</button>
				{/if}
			</section>

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
				<h2>이미지 업로드 폴더</h2>
				<p class="info-text">
					붙여넣기·드롭·파일 선택으로 추가된 이미지는 이 Dropbox 폴더에 업로드되고, 전체 공개
					공유 링크로 노트에 삽입됩니다. 노트 동기화 폴더와 분리해서 관리됩니다.
				</p>
				<div class="path-row">
					<input
						class="path-input"
						type="text"
						placeholder="/tomboy-image"
						bind:value={imagesPath}
						onkeydown={(e) => e.key === 'Enter' && handleSaveImagesPath()}
					/>
					<button class="btn-save" onclick={handleSaveImagesPath}>
						{imagesPathSaved ? '저장됨' : '저장'}
					</button>
				</div>
			</section>

			{#if authenticated}
				<section class="section">
					<h2>설정 동기화</h2>
					<p class="info-text">
						작업 공간 구성(열린 노트, 창 위치·크기 등)을 노트와 별도 폴더에 저장합니다. 프로필
						이름으로 여러 버전을 저장할 수 있습니다.
					</p>

					<div class="path-row">
						<input
							class="path-input"
							type="text"
							placeholder="/tomboy-settings"
							bind:value={settingsPath}
							onkeydown={(e) => e.key === 'Enter' && handleSaveSettingsPath()}
						/>
						<button class="btn-save" onclick={handleSaveSettingsPath}>
							{settingsPathSaved ? '저장됨' : '폴더 저장'}
						</button>
					</div>

					<div class="profile-row">
						<input
							class="path-input"
							type="text"
							placeholder="프로필 이름"
							bind:value={profileName}
						/>
						<button
							class="btn btn-primary profile-btn"
							onclick={handleSaveProfile}
							disabled={savingProfile}
						>
							{savingProfile ? '저장 중...' : '현재 설정 저장'}
						</button>
					</div>

					<div class="profile-row">
						<select class="path-input" bind:value={selectedProfile} disabled={profiles.length === 0}>
							{#if profiles.length === 0}
								<option value="">프로필 없음</option>
							{:else}
								{#each profiles as name}
									<option value={name}>{name}</option>
								{/each}
							{/if}
						</select>
						<button
							class="btn btn-secondary profile-btn"
							onclick={refreshProfiles}
							disabled={loadingProfiles}
						>
							{loadingProfiles ? '...' : '새로고침'}
						</button>
					</div>

					<button
						class="btn btn-primary"
						onclick={handleRestoreProfile}
						disabled={!selectedProfile || restoringProfile}
					>
						{#if restoringProfile}
							내려받는 중...
						{:else if restoreConfirm}
							덮어쓰기 확인 (다시 눌러 적용)
						{:else}
							선택한 프로필 내려받기
						{/if}
					</button>
					{#if restoreConfirm && !restoringProfile}
						<button class="btn btn-secondary" onclick={() => (restoreConfirm = false)}>취소</button>
					{/if}
				</section>
			{/if}
		{:else if activeTab === 'advanced'}
			<!-- ── 고급 탭 ─────────────────────────────────────────────────── -->
			{#if authenticated}
				<section class="section">
					<h2>관리자 페이지</h2>
					<p class="info-text">
						동기화 리비전 히스토리, 롤백, 파일 탐색, 백업 등을 다루는 관리자 페이지입니다.
					</p>
					<a href="/admin" class="btn btn-secondary admin-link">관리자 페이지 열기 →</a>
				</section>

				<section class="section danger-section">
					<h2>초기화</h2>
					<p class="info-text">
						로컬 노트와 동기화 상태를 모두 지우고 Dropbox에서 처음부터 다시 받습니다. 저장되지 않은
						변경사항은 잃습니다.
					</p>
					<button
						class="btn btn-danger"
						onclick={handleResetAndRedownload}
						disabled={resetting || processing || syncStatus === 'syncing'}
					>
						{#if resetting}
							다시 받는 중...
						{:else if resetConfirm}
							정말로 초기화할까요? (다시 눌러 확인)
						{:else}
							초기화하고 다시 받기
						{/if}
					</button>
					{#if resetConfirm && !resetting}
						<button class="btn btn-secondary" onclick={() => (resetConfirm = false)}>취소</button>
					{/if}
				</section>
			{:else}
				<section class="section">
					<p class="info-text">Dropbox에 연결된 뒤 고급 기능을 사용할 수 있습니다.</p>
					<button class="btn btn-secondary" onclick={() => (activeTab = 'config')}>
						동기화 설정 열기
					</button>
				</section>
			{/if}
		{/if}
	</main>
</div>

<style>
	.settings-page {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	.settings-tabs {
		display: flex;
		gap: 2px;
		padding: 0 clamp(8px, 2vw, 16px);
		border-bottom: 1px solid var(--color-border, #eee);
		background: var(--color-bg, #fff);
		flex-shrink: 0;
		overflow-x: auto;
	}

	.tab {
		flex: 0 0 auto;
		padding: clamp(10px, 2.5vw, 14px) clamp(12px, 3vw, 18px);
		border: none;
		background: transparent;
		font-size: clamp(0.85rem, 2.6vw, 0.95rem);
		font-weight: 500;
		color: var(--color-text-secondary, #888);
		cursor: pointer;
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		transition: color 0.1s;
		white-space: nowrap;
	}

	.tab:hover {
		color: var(--color-text, #111);
	}

	.tab.active {
		color: var(--color-primary, #d05b10);
		border-bottom-color: var(--color-primary, #d05b10);
		font-weight: 600;
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

	.status-dot.disconnected {
		background: #bbb;
	}

	.btn-disconnect {
		margin-left: auto;
		padding: 4px 10px;
		border: 1px solid #d93025;
		border-radius: 6px;
		background: transparent;
		color: #d93025;
		font-size: 0.8rem;
		cursor: pointer;
	}

	.btn-disconnect:active {
		background: #ffeef0;
	}

	.status-dot.syncing {
		background: var(--color-primary);
		animation: pulse 1s infinite;
	}

	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.4;
		}
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

	.clear-btn {
		margin-top: 8px;
		margin-bottom: 0;
	}

	.btn-secondary {
		background: transparent;
		color: var(--color-primary);
		border: 1px solid var(--color-primary);
	}

	.btn-secondary:active {
		background: #e8f0fe;
	}

	.admin-link {
		text-align: center;
		text-decoration: none;
		line-height: 1.4;
	}

	.btn-danger {
		background: #d93025;
		color: white;
	}

	.btn-danger:active:not(:disabled) {
		background: #a52714;
	}

	.danger-section h2 {
		color: #d93025;
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

	.profile-row {
		display: flex;
		gap: 8px;
		margin-top: 8px;
		margin-bottom: 4px;
	}

	.profile-btn {
		flex-shrink: 0;
		width: auto;
		margin-bottom: 0;
		padding: 10px 16px;
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

	.sync-progress-line {
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
