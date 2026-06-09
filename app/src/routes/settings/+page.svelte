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
	import { listNotes } from '$lib/core/noteManager.js';
	import {
		getScheduleNoteGuid,
		setScheduleNote,
		clearScheduleNote
	} from '$lib/core/schedule.js';
	import {
		enableNotifications,
		disableNotifications,
		forceResubscribe,
		isNotificationsEnabled,
		getStoredFcmToken,
		getNotificationDiagnostics,
		getPushSubscriptionDiagnostics,
		sendTestPush,
		showLocalTestNotification,
		type EnableFailReason,
		type PushSubscriptionDiagnostics
	} from '$lib/schedule/notification.js';
	import { flushIfEnabled } from '$lib/schedule/flushScheduler.js';
	import { getOrCreateInstallId } from '$lib/schedule/installId.js';
	import { setSetting } from '$lib/storage/appSettings.js';
	import {
		FIREBASE_NOTES_ENABLED_KEY,
		isFirebaseNotesEnabledSetting,
		installRealNoteSync
	} from '$lib/sync/firebase/install.js';
	import { setNoteSyncEnabled } from '$lib/sync/firebase/orchestrator.js';
	import {
		getDefaultTerminalBridge,
		setDefaultTerminalBridge,
		loginBridge,
		logoutBridge,
		checkBridgeAuth
	} from '$lib/editor/terminal/bridgeSettings.js';
	import {
		getTerminalHistoryPanelOpenDesktop,
		setTerminalHistoryPanelOpenDesktop,
		getTerminalHistoryPanelOpenMobile,
		setTerminalHistoryPanelOpenMobile,
		getTerminalHistoryBlocklist,
		setTerminalHistoryBlocklist,
		TERMINAL_HISTORY_BLOCKLIST_DEFAULT,
		getTerminalBellEnabled,
		setTerminalBellEnabled,
		getImageStorageToken,
		setImageStorageToken
	} from '$lib/storage/appSettings.js';
	import { listNotebooks, getNotebook } from '$lib/core/notebooks.js';
	import { getAllNotes } from '$lib/storage/noteStore.js';
	import { setNotebookPublic } from '$lib/sync/firebase/publishNotebook.js';
	import { readPublicConfigForHost } from '$lib/sync/firebase/publicConfig.js';
	import { ensureSignedIn } from '$lib/firebase/app.js';
	import { getStats as getImageCacheStats, setQuota as setImageCacheQuota, clearAll as clearImageCache } from '$lib/imageCache/imageCache.js';
	import {
		getClaudeDefaultSystem,
		setClaudeDefaultSystem,
		getClaudeDefaultModel,
		setClaudeDefaultModel,
		getClaudeDefaultEffort,
		setClaudeDefaultEffort
	} from '$lib/storage/appSettings.js';
	import { CLAUDE_VALID_EFFORTS } from '$lib/chatNote/defaults.js';
	import RemarkableSendSettings from '$lib/remarkable/RemarkableSendSettings.svelte';

	type Tab = 'sync' | 'config' | 'share' | 'terminal' | 'notify' | 'guide' | 'shortcuts' | 'advanced' | 'claude' | 'remarkable';
	let activeTab = $state<Tab>('sync');

	// 가이드 탭 내부 sub-tab. 콘텐츠 양이 많아 카테고리별 분리.
	// 새 노트 형식 / 에디터 블록 / 환경 요구사항을 추가할 때마다 해당 sub-tab 에
	// guide-card 를 한 장 더 끼워 넣는다.
	type GuideSubTab = 'notes' | 'editor' | 'env';
	let guideSubTab = $state<GuideSubTab>('notes');

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

	// ── 원격 브릿지 ───────────────────────────────────────────────────
	let terminalBridgeUrl = $state('');
	let terminalBridgeSaved = $state(false);
	let terminalBridgePassword = $state('');
	let terminalBridgeAuthed = $state<boolean | null>(null); // null = unknown
	let terminalBridgeBusy = $state(false);
	let terminalBridgeMessage = $state('');

	// ── 이미지 서버 토큰 ──────────────────────────────────────────────
	let imageStorageToken = $state('');
	let imageStorageTokenSaved = $state(false);

	// ── Claude 기본값 ─────────────────────────────────────────────────
	let claudeDefSystem = $state('');
	let claudeDefModel = $state('');
	let claudeDefEffort = $state('high');
	let claudeDefSaved = $state(false);

	// ── 터미널 히스토리 설정 ──────────────────────────────────────────
	let termHistOpenDesktop = $state(true);
	let termHistOpenMobile = $state(false);
	let termHistBlocklistText = $state('');
	let termBellEnabled = $state(true);
	let snippetCopied = $state(false);
	let loaderCopied = $state(false);
	let tmuxSnippetCopied = $state(false);

	// Recommended remote path for the integration script. Single file in
	// $HOME keeps the setup simple (no mkdir step) and the user's ~/.bashrc
	// stays clean — only the loader line below lives in .bashrc.
	const shellSnippetPath = '~/.tomboy-terminal.sh';
	const shellLoaderLine = `[ -f ${shellSnippetPath} ] && . ${shellSnippetPath}`;

	const shellSnippet = `# ~/.tomboy-terminal.sh — Tomboy 터미널 노트 셸 통합 (bash 4.4+)
# Load from ~/.bashrc:  ${shellLoaderLine}
__th_state_file="\${XDG_RUNTIME_DIR:-/tmp}/.th_state_$$"

__th_osc() {
  if [ -n "$TMUX" ]; then
    printf '\\ePtmux;\\e\\e]133;%s\\a\\e\\\\' "$1"
  else
    printf '\\e]133;%s\\a' "$1"
  fi
}

__th_emit_C() {
  # PS0 (fires after Enter, before exec) creates the state file. The very
  # next DEBUG is the user's command — capture and clear. PROMPT_COMMAND
  # internals fire DEBUG without the file present, so they're skipped.
  [ -e "$__th_state_file" ] || return
  rm -f "$__th_state_file"
  local hex win payload
  hex=$(printf '%s' "$1" | od -An -tx1 | tr -d ' \\n')
  if [ -e "\${__th_state_file}.win" ]; then
    win=$(cat "\${__th_state_file}.win" 2>/dev/null)
    rm -f "\${__th_state_file}.win"
  fi
  if [ -n "$win" ]; then
    payload="C;$hex;$win"
  else
    payload="C;$hex"
  fi
  __th_osc "$payload"
}

# Reports the current shell context on every prompt. The history panel uses
# this to switch buckets after tmux start/exit/detach/attach/window-change
# without any tmux.conf hook required.
__th_emit_W() {
  if [ -n "$TMUX" ]; then
    local id; id=$(tmux display -p '#{window_id}' 2>/dev/null)
    __th_osc "W;$id"
  else
    __th_osc "W"
  fi
}

PS0='$(: > "$__th_state_file" 2>/dev/null
       [ -n "$TMUX" ] && tmux display -p "#{window_id}" \\
         > "\${__th_state_file}.win" 2>/dev/null)'
# If PS1 is unset/empty when this snippet is sourced (typical when the
# loader line in ~/.bashrc runs before PS1 is set, or when /etc/bashrc
# defers PS1 to login profile), the wrapper below would produce a prompt
# made entirely of zero-width markers — the xterm would render as blank
# because the OSC 133 handler suppresses the markers. Fall back to a
# minimal default so the prompt is always visible.
[ -z "$PS1" ] && PS1='\\u@\\h:\\w\\$ '
PS1='\\[$(__th_osc A)$(__th_emit_W)\\]'"$PS1"'\\[$(__th_osc B)\\]'
PROMPT_COMMAND='rm -f "$__th_state_file" "\${__th_state_file}.win" 2>/dev/null
                __th_osc "D;$?"'"\${PROMPT_COMMAND:+; \$PROMPT_COMMAND}"
trap '__th_emit_C "$BASH_COMMAND"' DEBUG`;

	const tmuxHookSnippet = `# Append to ~/.tmux.conf (optional — reduces panel-update latency).
# The bash snippet above polls the current shell context on every prompt,
# so most cases (tmux start/exit, next-command in a switched window) are
# handled automatically. These hooks make two transitions instant instead
# of next-prompt: window switch (you stop typing in win @1, switch to @2)
# and tmux attach (you reconnect to a running session).
set-hook -g after-select-window 'run-shell "printf \\"\\\\ePtmux;\\\\e\\\\e]133;W;#{window_id}\\\\a\\\\e\\\\\\\\\\" > #{client_tty}"'
set-hook -g client-attached 'run-shell "printf \\"\\\\ePtmux;\\\\e\\\\e]133;W;#{window_id}\\\\a\\\\e\\\\\\\\\\" > #{client_tty}"'`;

	async function loadTerminalBridgeState(): Promise<void> {
		const v = await getDefaultTerminalBridge();
		terminalBridgeUrl = v ?? '';
		await refreshTerminalBridgeAuth();
	}

	async function refreshTerminalBridgeAuth(): Promise<void> {
		if (!terminalBridgeUrl.trim()) {
			terminalBridgeAuthed = null;
			return;
		}
		try {
			terminalBridgeAuthed = await checkBridgeAuth(terminalBridgeUrl);
		} catch {
			terminalBridgeAuthed = false;
		}
	}

	async function handleSaveTerminalBridge(): Promise<void> {
		const v = terminalBridgeUrl.trim();
		await setDefaultTerminalBridge(v || undefined);
		terminalBridgeSaved = true;
		setTimeout(() => (terminalBridgeSaved = false), 1500);
		await refreshTerminalBridgeAuth();
	}

	async function handleTerminalBridgeLogin(): Promise<void> {
		if (terminalBridgeBusy) return;
		const v = terminalBridgeUrl.trim();
		if (!v) {
			terminalBridgeMessage = '브릿지 URL을 먼저 입력하세요.';
			return;
		}
		terminalBridgeBusy = true;
		terminalBridgeMessage = '';
		try {
			const ok = await loginBridge(v, terminalBridgePassword);
			if (ok) {
				terminalBridgePassword = '';
				terminalBridgeAuthed = true;
				terminalBridgeMessage = '로그인되었습니다.';
			} else {
				terminalBridgeAuthed = false;
				terminalBridgeMessage = '로그인 실패 (비밀번호 또는 브릿지 URL 확인).';
			}
		} catch (err) {
			terminalBridgeMessage = `오류: ${(err as Error).message}`;
		} finally {
			terminalBridgeBusy = false;
		}
	}

	async function handleTerminalBridgeLogout(): Promise<void> {
		await logoutBridge();
		terminalBridgeAuthed = false;
		terminalBridgeMessage = '로그아웃되었습니다.';
	}

	async function loadTerminalHistorySettings(): Promise<void> {
		termHistOpenDesktop = await getTerminalHistoryPanelOpenDesktop();
		termHistOpenMobile = await getTerminalHistoryPanelOpenMobile();
		const list = await getTerminalHistoryBlocklist();
		termHistBlocklistText = list.join(', ');
		termBellEnabled = await getTerminalBellEnabled();
	}

	async function saveTermHistOpenDesktop(): Promise<void> {
		await setTerminalHistoryPanelOpenDesktop(termHistOpenDesktop);
	}
	async function saveTermHistOpenMobile(): Promise<void> {
		await setTerminalHistoryPanelOpenMobile(termHistOpenMobile);
	}
	async function saveTermBellEnabled(): Promise<void> {
		await setTerminalBellEnabled(termBellEnabled);
	}
	async function saveTermHistBlocklist(): Promise<void> {
		const items = termHistBlocklistText
			.split(',')
			.map((s) => s.trim())
			.filter((s) => s !== '');
		await setTerminalHistoryBlocklist(items);
	}
	async function resetTermHistBlocklist(): Promise<void> {
		termHistBlocklistText = TERMINAL_HISTORY_BLOCKLIST_DEFAULT.join(', ');
		await setTerminalHistoryBlocklist([...TERMINAL_HISTORY_BLOCKLIST_DEFAULT]);
	}

	async function saveImageStorageToken(): Promise<void> {
		await setImageStorageToken(imageStorageToken.trim());
		imageStorageTokenSaved = true;
		setTimeout(() => (imageStorageTokenSaved = false), 1500);
	}

	async function saveClaudeDefaults(): Promise<void> {
		await setClaudeDefaultSystem(claudeDefSystem);
		await setClaudeDefaultModel(claudeDefModel.trim());
		await setClaudeDefaultEffort(claudeDefEffort);
		claudeDefSaved = true;
		setTimeout(() => (claudeDefSaved = false), 1500);
	}

	async function copySnippet(): Promise<void> {
		await navigator.clipboard.writeText(shellSnippet);
		snippetCopied = true;
		setTimeout(() => {
			snippetCopied = false;
		}, 2000);
	}

	async function copyLoader(): Promise<void> {
		await navigator.clipboard.writeText(shellLoaderLine);
		loaderCopied = true;
		setTimeout(() => {
			loaderCopied = false;
		}, 2000);
	}

	async function copyTmuxHookSnippet(): Promise<void> {
		try {
			await navigator.clipboard.writeText(tmuxHookSnippet);
			tmuxSnippetCopied = true;
			setTimeout(() => {
				tmuxSnippetCopied = false;
			}, 2000);
		} catch (err) {
			console.warn('clipboard write failed', err);
		}
	}

	// ── 이미지 캐시 ──────────────────────────────────────────────────────
	let imageCacheStats = $state<{ count: number; totalBytes: number; quotaBytes: number } | null>(null);
	let imageCacheQuotaMb = $state(500);

	async function refreshImageCacheStats(): Promise<void> {
		imageCacheStats = await getImageCacheStats();
		imageCacheQuotaMb = Math.round(imageCacheStats.quotaBytes / (1024 * 1024));
	}

	function formatMb(bytes: number): string {
		return (bytes / (1024 * 1024)).toFixed(1);
	}

	async function handleImageCacheQuotaChange(): Promise<void> {
		const clamped = Math.max(100, Math.min(5000, Math.floor(imageCacheQuotaMb)));
		imageCacheQuotaMb = clamped;
		await setImageCacheQuota(clamped * 1024 * 1024);
		await refreshImageCacheStats();
		pushToast(`이미지 캐시 한도 ${clamped}MB로 변경되었습니다.`);
	}

	async function handleImageCacheClear(): Promise<void> {
		if (!confirm('이미지 캐시를 모두 비우시겠습니까?')) return;
		await clearImageCache();
		await refreshImageCacheStats();
		pushToast('이미지 캐시를 비웠습니다.');
	}

	$effect(() => {
		void refreshImageCacheStats();
	});

	// ── 파이어베이스 실시간 노트 동기화 ──────────────────────────────────
	let firebaseNotesEnabled = $state(false);
	let firebaseNotesBusy = $state(false);

	async function loadFirebaseNotesState(): Promise<void> {
		firebaseNotesEnabled = await isFirebaseNotesEnabledSetting();
	}

	async function handleFirebaseNotesToggle(): Promise<void> {
		if (firebaseNotesBusy) return;
		firebaseNotesBusy = true;
		try {
			const next = !firebaseNotesEnabled;
			await setSetting(FIREBASE_NOTES_ENABLED_KEY, next);
			// Make sure orchestrator is wired with real adapters before flipping on.
			await installRealNoteSync();
			setNoteSyncEnabled(next);
			firebaseNotesEnabled = next;
			pushToast(
				next
					? '파이어베이스 실시간 노트 동기화가 활성화되었습니다.'
					: '파이어베이스 실시간 노트 동기화가 비활성화되었습니다.',
				{ kind: 'info' }
			);
		} catch (err) {
			pushToast(`설정 변경 실패: ${String(err)}`, { kind: 'error' });
		} finally {
			firebaseNotesBusy = false;
		}
	}

	// ── 공유 탭 ──────────────────────────────────────────────────────────
	let shareNotebooks = $state<string[]>([]);
	let shareCounts = $state(new Map<string, number>());
	let sharedSet = $state(new Set<string>());
	let shareBusy = $state(false);
	let shareBusyDone = $state(0);
	let shareBusyTotal = $state(0);
	let shareLoaded = $state(false);

	async function loadShareTab(): Promise<void> {
		shareLoaded = false;
		shareNotebooks = await listNotebooks();
		const all = await getAllNotes();
		const counts = new Map<string, number>();
		for (const n of all) {
			if (n.deleted) continue;
			const nb = getNotebook(n);
			if (nb) counts.set(nb, (counts.get(nb) ?? 0) + 1);
		}
		shareCounts = counts;
		try {
			const user = await ensureSignedIn();
			const cfg = await readPublicConfigForHost(user.uid);
			sharedSet = new Set(cfg.sharedNotebooks);
		} catch {
			sharedSet = new Set();
		}
		shareLoaded = true;
	}

	async function toggleShareNotebook(name: string, on: boolean): Promise<void> {
		const count = shareCounts.get(name) ?? 0;
		const verb = on ? '공유 시작' : '공유 해제';
		const msg = `노트북 '${name}'의 ${count}개 노트를 ${verb}하시겠습니까?`;
		if (!confirm(msg)) {
			// restore checkbox state — reload share tab
			await loadShareTab();
			return;
		}
		shareBusy = true;
		shareBusyDone = 0;
		shareBusyTotal = count;
		try {
			await setNotebookPublic(name, on, (d, t) => {
				shareBusyDone = d;
				shareBusyTotal = t;
			});
		} catch (e) {
			pushToast(`작업 실패: ${(e as Error).message ?? e}`, { kind: 'error' });
		}
		shareBusy = false;
		await loadShareTab();
	}

	$effect(() => {
		if (activeTab === 'share' && !shareLoaded) {
			void loadShareTab();
		}
	});

	// ── 일정 알림 (notify 탭) ────────────────────────────────────────────
	let notifyNotes = $state<{ guid: string; title: string }[]>([]);
	let notifyScheduleGuid = $state<string | null>(null);
	let notifyEnabled = $state(false);
	let notifyToken = $state<string | undefined>(undefined);
	let notifyInstallId = $state('');
	let notifyBusy = $state(false);
	let notifyBrowserSupported = $state(true);
	let notifyDiagText = $state('');
	let pushSubDiag = $state<PushSubscriptionDiagnostics | null>(null);
	let notifyStep = $state('');

	const FAIL_REASON_KO: Record<EnableFailReason, string> = {
		'no-window': '브라우저 환경이 아닙니다.',
		'no-notification-api': '브라우저가 알림 API를 지원하지 않습니다.',
		'no-service-worker': '브라우저가 서비스워커를 지원하지 않습니다.',
		'not-pwa-installed':
			'iOS는 PWA를 홈 화면에 설치한 뒤 그 아이콘으로 실행해야 알림을 켤 수 있습니다.',
		'permission-denied': '브라우저 알림 권한이 거부되었습니다. 시스템 설정에서 허용해주세요.',
		'permission-default':
			'권한 팝업이 닫히기 전에 응답되지 않았습니다. 다시 한 번 눌러주세요.',
		'fcm-unsupported': '이 브라우저는 FCM Web Push를 지원하지 않습니다.',
		'sw-registration-failed':
			'서비스워커가 준비되지 않았습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.',
		'sw-timeout':
			'서비스워커 활성화 대기 중 타임아웃. PWA를 강제 종료한 뒤 다시 열어주세요.',
		'dropbox-not-connected':
			'Dropbox 연결이 필요합니다. 동기화 탭에서 먼저 Dropbox에 연결해주세요. (같은 Dropbox 계정을 쓰는 모든 기기가 같은 일정을 공유합니다.)',
		'dropbox-scope-missing':
			'Dropbox 권한 갱신이 필요합니다. 동기화 탭에서 "연결 끊기" 후 다시 "Dropbox 연결" 을 눌러주세요. (account_info.read 권한이 추가됐습니다.)',
		'auth-failed':
			'Firebase 로그인 실패. Dropbox 연결 상태와 네트워크를 확인하고 다시 시도해주세요.',
		'token-failed': 'FCM 토큰 발급에 실패했습니다. 콘솔 로그를 확인하세요.',
		'firestore-failed': 'Firestore에 토큰을 저장하지 못했습니다. 콘솔 로그를 확인하세요.'
	};

	async function loadNotifyState() {
		notifyNotes = (await listNotes()).map((n) => ({ guid: n.guid, title: n.title }));
		notifyScheduleGuid = (await getScheduleNoteGuid()) ?? null;
		notifyEnabled = await isNotificationsEnabled();
		notifyToken = await getStoredFcmToken();
		notifyInstallId = await getOrCreateInstallId();
		notifyBrowserSupported =
			typeof window !== 'undefined' &&
			'Notification' in window &&
			'serviceWorker' in navigator;
		// Always-visible diagnostics so the user sees what's blocking activation.
		const d = getNotificationDiagnostics();
		notifyDiagText = `permission=${d.permission} standalone=${d.standalone} sw=${d.hasServiceWorker} api=${d.hasNotificationApi}`;
		pushSubDiag = await getPushSubscriptionDiagnostics().catch(() => null);
	}

	async function refreshPushSubDiag() {
		pushSubDiag = await getPushSubscriptionDiagnostics().catch(() => null);
	}

	async function onSelectScheduleNote(e: Event) {
		const value = (e.target as HTMLSelectElement).value;
		if (!value) {
			await clearScheduleNote();
			notifyScheduleGuid = null;
		} else {
			await setScheduleNote(value);
			notifyScheduleGuid = value;
			pushToast('일정 노트가 지정되었습니다. 다음 저장 시부터 일정이 추적됩니다.');
		}
	}

	async function onEnableNotify() {
		notifyBusy = true;
		notifyStep = '시작';
		try {
			const r = await enableNotifications((s) => (notifyStep = s));
			if (r.ok) {
				notifyEnabled = true;
				notifyToken = r.token;
				pushToast('알림이 활성화되었습니다.');
				// 활성화되자마자 미발신 diff가 있으면 즉시 발송.
				await flushIfEnabled();
			} else {
				const base = FAIL_REASON_KO[r.reason] ?? `등록 실패: ${r.reason}`;
				const message = r.detail ? `${base} — ${r.detail}` : base;
				pushToast(message, { kind: 'error' });
				console.error('[schedule] enableNotifications failed', r);
			}
		} catch (err) {
			console.error('[schedule] onEnableNotify threw', err);
			pushToast(`알림 활성화 중 오류: ${String(err)}`, { kind: 'error' });
		} finally {
			notifyBusy = false;
			// 진단 정보 갱신 (permission이 바뀌었을 수 있음 + push subscription
			// 이 활성화 직후엔 일시적으로 null 일 수 있어 약간 지연 후 한 번 더)
			const d = getNotificationDiagnostics();
			notifyDiagText = `permission=${d.permission} standalone=${d.standalone} sw=${d.hasServiceWorker} api=${d.hasNotificationApi}`;
			await refreshPushSubDiag();
			setTimeout(() => void refreshPushSubDiag(), 500);
		}
	}

	async function onDisableNotify() {
		notifyBusy = true;
		await disableNotifications();
		notifyEnabled = false;
		notifyToken = undefined;
		pushToast('알림이 비활성화되었습니다. (등록된 기기는 그대로 유지)');
		notifyBusy = false;
	}

	async function onLocalTest() {
		try {
			await showLocalTestNotification();
			pushToast('로컬 알림 호출 완료 — 잠금화면/알림 센터를 확인하세요.');
		} catch (err) {
			pushToast(`로컬 알림 실패: ${String(err)}`, { kind: 'error' });
		}
	}

	async function onForceResubscribe() {
		notifyBusy = true;
		notifyStep = '시작';
		try {
			const r = await forceResubscribe((s) => (notifyStep = s));
			if (r.ok) {
				notifyEnabled = true;
				notifyToken = r.token;
				pushToast('재구독 완료. 이제 FCM 테스트 푸시를 다시 시도해보세요.');
				await loadNotifyState();
			} else {
				const msg = FAIL_REASON_KO[r.reason] ?? `재구독 실패: ${r.reason}`;
				pushToast(msg, { kind: 'error' });
				console.error('[schedule] forceResubscribe failed', r);
			}
		} catch (err) {
			console.error('[schedule] forceResubscribe threw', err);
			pushToast(`재구독 중 오류: ${String(err)}`, { kind: 'error' });
		} finally {
			notifyBusy = false;
			await loadNotifyState();
		}
	}

	async function onFcmTest() {
		notifyBusy = true;
		try {
			const r = await sendTestPush();
			if (r.failureCount === 0 && r.successCount > 0) {
				pushToast(
					`FCM 전송 성공 (${r.successCount}/${r.tokenCount}) — 알림 도착 여부 확인하세요.`
				);
			} else {
				pushToast(
					`FCM 일부/전부 실패: 성공 ${r.successCount} / 실패 ${r.failureCount}. ${r.errors.join('; ')}`,
					{ kind: 'error' }
				);
			}
			console.info('[schedule] sendTestPush result', r);
		} catch (err) {
			pushToast(`FCM 호출 실패: ${String(err)}`, { kind: 'error' });
			console.error('[schedule] sendTestPush threw', err);
		} finally {
			notifyBusy = false;
			await refreshPushSubDiag();
		}
	}

	onMount(() => {
		notesPath = getNotesPath();
		settingsPath = getSettingsPath();
		imagesPath = getImagesPath();
		void loadTerminalBridgeState();
		void loadTerminalHistorySettings();
		void getImageStorageToken().then((v) => (imageStorageToken = v));
		void getClaudeDefaultSystem().then((v) => (claudeDefSystem = v));
		void getClaudeDefaultModel().then((v) => (claudeDefModel = v));
		void getClaudeDefaultEffort().then((v) => (claudeDefEffort = v));

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

		void loadNotifyState();
		void loadFirebaseNotesState();
		// First page mount can race the SW activation. Re-check after a beat
		// so a transient null subscription doesn't get pinned in the UI.
		setTimeout(() => void refreshPushSubDiag(), 1500);

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
			syncResult = { status: 'error', uploaded: 0, downloaded: 0, deleted: 0, merged: 0, errors: [String(e)] };
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
		{ id: 'share', label: '공유' },
		{ id: 'terminal', label: '터미널' },
		{ id: 'notify', label: '알림' },
		{ id: 'guide', label: '가이드' },
		{ id: 'shortcuts', label: '단축키' },
		{ id: 'advanced', label: '고급' },
		{ id: 'claude', label: 'Claude' },
		{ id: 'remarkable', label: '리마커블' }
	];

	const guideSubTabs: { id: GuideSubTab; label: string }[] = [
		{ id: 'notes', label: '노트 형식' },
		{ id: 'editor', label: '에디터 블록' },
		{ id: 'env', label: '환경 / 호환성' }
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
								업로드: {syncResult.uploaded} / 다운로드: {syncResult.downloaded} / 삭제: {syncResult.deleted}{#if syncResult.merged > 0} / 자동 머지: {syncResult.merged}{/if}
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
				<h2>파이어베이스 실시간 동기화</h2>
				<p class="info-text">
					노트가 열려 있는 동안 변경사항이 즉시 파이어베이스에 반영되고, 다른 기기에서도 같은
					노트가 열려 있으면 실시간으로 따라옵니다. Dropbox 동기화는 백업 채널로 그대로
					유지됩니다.
				</p>
				<p class="info-text small">
					같은 Dropbox 계정에 연결된 기기끼리만 공유됩니다. 충돌이 나면 수정 시각이 더 늦은 쪽이
					이깁니다. 한 번도 열린 적 없는 노트는 파이어베이스에 올라가지 않으니 처음 한 번씩만
					열어두면 됩니다.
				</p>
				<label class="form-row">
					<input
						type="checkbox"
						checked={firebaseNotesEnabled}
						disabled={firebaseNotesBusy}
						onchange={() => void handleFirebaseNotesToggle()}
					/>
					<span class="form-label">실시간 동기화 사용</span>
				</label>
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

			<section class="section">
				<h2>이미지 서버 토큰</h2>
				<p class="info-text">
					이미지 붙여넣기 시 Vercel Blob에 업로드할 때 사용되는 Bearer 토큰입니다.
					서버의 <code>IMAGE_STORAGE_TOKEN</code> 환경변수와 동일하게 설정하세요.
					기기마다 한 번씩 입력이 필요합니다.
				</p>
				<div class="path-row">
					<input
						class="path-input"
						type="password"
						bind:value={imageStorageToken}
						placeholder="••••••••"
						onkeydown={(e) => e.key === 'Enter' && saveImageStorageToken()}
					/>
					<button class="btn-save" onclick={saveImageStorageToken}>
						{imageStorageTokenSaved ? '저장됨' : '저장'}
					</button>
				</div>
			</section>

			<section class="section">
				<h2>이미지 캐시</h2>
				<p class="info-text">
					노트에 붙여넣은 이미지를 이 기기에 저장해서 다시 열 때 네트워크 요청 없이 즉시
					표시합니다. 한도를 초과하면 오래된 이미지부터 자동으로 지워집니다.
				</p>
				{#if imageCacheStats}
					<p class="info-text">
						사용 중:
						<strong>{formatMb(imageCacheStats.totalBytes)}MB</strong>
						/ {formatMb(imageCacheStats.quotaBytes)}MB ({imageCacheStats.count}개)
					</p>
					<div class="path-row image-cache-quota-row">
						<label class="image-cache-quota-label" for="image-cache-quota-input">한도 (MB)</label>
						<input
							id="image-cache-quota-input"
							class="path-input image-cache-quota-input"
							type="number"
							min="100"
							max="5000"
							step="50"
							bind:value={imageCacheQuotaMb}
							onchange={handleImageCacheQuotaChange}
						/>
					</div>
					<button type="button" class="btn btn-secondary" onclick={handleImageCacheClear}>
						캐시 비우기
					</button>
				{:else}
					<p class="info-text">불러오는 중…</p>
				{/if}
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
		{:else if activeTab === 'share'}
			<!-- ── 공유 탭 ───────────────────────────────────────────────────── -->
			<section class="section">
				<h2>공유 노트북</h2>
				<p class="hint">체크된 노트북은 Dropbox 로그인 없이 누구나 접근할 수 있습니다.</p>
				{#if !shareLoaded}
					<p>로딩 중…</p>
				{:else if shareNotebooks.length === 0}
					<p>노트북이 없습니다.</p>
				{:else}
					<ul class="share-list">
						{#each shareNotebooks as nb (nb)}
							<li class="share-row">
								<label>
									<input
										type="checkbox"
										checked={sharedSet.has(nb)}
										disabled={shareBusy}
										onchange={(e) => toggleShareNotebook(nb, e.currentTarget.checked)}
									/>
									<span class="share-name">{nb}</span>
									<span class="share-count">노트 {shareCounts.get(nb) ?? 0}개</span>
								</label>
							</li>
						{/each}
					</ul>
				{/if}

				{#if shareBusy}
					<div class="share-progress">
						<progress max={shareBusyTotal} value={shareBusyDone}></progress>
						<p>{shareBusyDone} / {shareBusyTotal}</p>
					</div>
				{/if}
			</section>
		{:else if activeTab === 'terminal'}
			<!-- ── 터미널 탭 ───────────────────────────────────────────────── -->
			<section class="section">
				<h2>브릿지 연결</h2>
				<p class="info-text">
					터미널 노트(<code>ssh://...</code> 형식)를 열 때 사용할 기본 브릿지 URL을 설정합니다.
					노트 본문에 <code>bridge:</code> 줄이 없으면 이 값이 사용됩니다.
					브릿지에 한 번 로그인하면 토큰이 저장되어 모든 터미널 노트에서 재사용됩니다.
				</p>

				<div class="path-row">
					<input
						class="path-input"
						type="text"
						placeholder="wss://my-pc.duckdns.org:443"
						bind:value={terminalBridgeUrl}
						onkeydown={(e) => e.key === 'Enter' && handleSaveTerminalBridge()}
					/>
					<button class="btn-save" onclick={handleSaveTerminalBridge}>
						{terminalBridgeSaved ? '저장됨' : '저장'}
					</button>
				</div>

				<div class="profile-row">
					<input
						class="path-input"
						type="password"
						placeholder="브릿지 비밀번호"
						autocomplete="current-password"
						bind:value={terminalBridgePassword}
						onkeydown={(e) => e.key === 'Enter' && handleTerminalBridgeLogin()}
					/>
					<button
						class="btn btn-primary profile-btn"
						onclick={handleTerminalBridgeLogin}
						disabled={terminalBridgeBusy || !terminalBridgeUrl.trim()}
					>
						{terminalBridgeBusy ? '로그인 중...' : '로그인'}
					</button>
				</div>

				<div class="profile-row">
					<span class="info-text small">
						상태:
						{#if terminalBridgeAuthed === true}
							<code>인증됨</code>
						{:else if terminalBridgeAuthed === false}
							<code>로그아웃됨</code>
						{:else}
							<code>—</code>
						{/if}
					</span>
					<button
						class="btn btn-secondary profile-btn"
						onclick={handleTerminalBridgeLogout}
						disabled={terminalBridgeAuthed !== true}
					>
						로그아웃
					</button>
				</div>

				{#if terminalBridgeMessage}
					<p class="info-text small">{terminalBridgeMessage}</p>
				{/if}
			</section>

			<section class="section">
				<h2>명령어 히스토리</h2>
				<p class="info-text">
					터미널 노트 우측 패널에 표시되는 최근 명령어 목록입니다. 노트 본문에
					저장되어 모든 디바이스에서 공유됩니다. 최대 50개까지 보관됩니다.
				</p>

				<label class="profile-row">
					<input type="checkbox" bind:checked={termHistOpenDesktop} onchange={saveTermHistOpenDesktop} />
					<span>데스크톱에서 패널 기본 열림</span>
				</label>
				<label class="profile-row">
					<input type="checkbox" bind:checked={termHistOpenMobile} onchange={saveTermHistOpenMobile} />
					<span>모바일에서 패널 기본 열림</span>
				</label>

				<p class="info-text small">기록하지 않을 명령어 (첫 토큰 기준, 콤마 구분)</p>
				<textarea
					class="path-input"
					rows="2"
					bind:value={termHistBlocklistText}
					onblur={saveTermHistBlocklist}
				></textarea>
				<button class="btn btn-secondary" onclick={resetTermHistBlocklist}>기본값으로 되돌리기</button>
			</section>

			<section class="section">
				<h2>터미널 벨</h2>
				<p class="info-text">
					터미널이 벨(<code>{'\\x07'}</code>)을 울리면 — 예: 클로드 코드가
					작업을 마칠 때 — 노트에서 짧은 소리와 진동으로 알립니다. shell
					모드에서만 동작하며, 노트가 화면에 떠 있을 때만 인지됩니다.
				</p>
				<label class="profile-row">
					<input
						type="checkbox"
						bind:checked={termBellEnabled}
						onchange={saveTermBellEnabled}
					/>
					<span>터미널 벨 소리/진동 켜기</span>
				</label>
			</section>

			<section class="section">
				<h2>셸 통합 (OSC 133)</h2>
				<p class="info-text">
					히스토리 캡처에는 원격 셸에 1회 설정이 필요합니다.
					<code>~/.bashrc</code>가 지저분해지지 않도록, 스니펫은 별도 파일에
					저장하고 <code>~/.bashrc</code>에서 한 줄로 로드합니다.
				</p>

				<p class="info-text small">
					<strong>1단계.</strong> 아래 스니펫을 원격의
					<code>{shellSnippetPath}</code> 파일로 저장하세요.
				</p>
				<pre class="snippet"><code>{shellSnippet}</code></pre>
				<button class="btn btn-secondary" onclick={copySnippet}>{snippetCopied ? '복사됨' : '복사'}</button>

				<p class="info-text small">
					<strong>2단계.</strong> 원격의 <code>~/.bashrc</code> 끝에 다음 한 줄을
					추가하세요 (zsh 사용 시 <code>~/.zshrc</code>; 위 스니펫은 bash 4.4+
					전용이라 zsh에서는 다른 스니펫이 필요합니다).
				</p>
				<pre class="snippet"><code>{shellLoaderLine}</code></pre>
				<button class="btn btn-secondary" onclick={copyLoader}>{loaderCopied ? '복사됨' : '복사'}</button>

				<p class="info-text small">
					tmux 사용 시: 위 스니펫이 <code>$TMUX</code> 환경변수를 자동 감지해
					DCS 패스스루로 래핑합니다. 추가로, 윈도우 전환 즉시 패널을
					동기화하려면 다음을 <code>~/.tmux.conf</code>에 추가하세요. (선택 사항 —
					추가하지 않아도 다음 명령을 입력하는 시점에 자동 동기화됩니다.)
				</p>
				<pre class="snippet"><code>{tmuxHookSnippet}</code></pre>
				<button class="btn btn-secondary" onclick={copyTmuxHookSnippet}>{tmuxSnippetCopied ? '복사됨' : '복사'}</button>
			</section>

			<section class="section">
				<h2>보안 안내</h2>
				<ul class="info-text">
					<li>명령어 히스토리는 노트 본문에 평문으로 저장되어 Dropbox/Firestore와 동기화됩니다. <strong>비밀번호를 명령 인자로 입력하지 마세요</strong>.</li>
					<li>공백 또는 탭으로 시작하는 명령은 캡처되지 않습니다 (<code>HISTCONTROL=ignorespace</code> 관행). 일회성으로 민감한 명령을 숨기고 싶다면 명령 앞에 공백을 한 칸 두고 입력하세요.</li>
				</ul>
			</section>

		{:else if activeTab === 'notify'}
			<!-- ── 알림 탭 ─────────────────────────────────────────────────── -->
			<section class="section">
				<h2>일정 노트</h2>
				<p class="info-text">
					지정된 노트의 list-item 형식 일정을 자동으로 파싱해서, 시각이 적힌 일정은 30분 전,
					날짜만 있는 일정은 당일 오전 7시에 알림을 보냅니다.
				</p>
				<label class="form-row">
					<span class="form-label">대상 노트</span>
					<select onchange={onSelectScheduleNote} value={notifyScheduleGuid ?? ''}>
						<option value="">— 지정 안 함 —</option>
						{#each notifyNotes as n (n.guid)}
							<option value={n.guid}>{n.title}</option>
						{/each}
					</select>
				</label>
			</section>

			<section class="section">
				<h2>푸시 알림</h2>
				<p class="info-text small">상태: <code>{notifyDiagText}</code></p>
				{#if pushSubDiag}
					<details class="diag-details">
						<summary>
							Push 구독 진단
							<button
								class="diag-refresh"
								type="button"
								onclick={(e) => {
									e.preventDefault();
									void refreshPushSubDiag();
								}}>↻</button>
						</summary>
						<ul class="diag-list">
							<li>구독 존재: <code>{pushSubDiag.hasSubscription}</code></li>
							{#if pushSubDiag.endpointHost}
								<li>
									Push 서비스: <code>{pushSubDiag.endpointHost}</code>
									{#if pushSubDiag.endpointHost.includes('apple')}
										✓ APNs
									{:else}
										⚠ APNs 아님 (iOS인데 다른 호스트면 PWA 미설치 가능성)
									{/if}
								</li>
							{/if}
							<li>설정된 VAPID 키 prefix: <code>{pushSubDiag.configuredVapidKeyPrefix}</code></li>
							{#if pushSubDiag.applicationServerKeyPrefix}
								<li>구독의 app server key prefix: <code>{pushSubDiag.applicationServerKeyPrefix}</code></li>
							{/if}
							<li>
								설정 키와 일치 여부:
								{#if pushSubDiag.applicationServerKeyPrefix && pushSubDiag.configuredVapidKeyPrefix.startsWith(pushSubDiag.applicationServerKeyPrefix)}
									<strong>일치</strong>
								{:else}
									<strong style="color: red">불일치 — VAPID 키 mismatch</strong>
								{/if}
							</li>
						</ul>
					</details>
				{/if}
				{#if !notifyBrowserSupported}
					<p class="info-text">
						이 브라우저는 푸시 알림을 지원하지 않습니다. iOS에서는 PWA를 홈 화면에 설치하면
						사용할 수 있습니다.
					</p>
				{:else if notifyEnabled}
					<p class="info-text">
						<strong>활성</strong> — 이 기기로 알림이 전송됩니다.
					</p>
					{#if notifyToken}
						<p class="info-text small">기기 ID: <code>{notifyInstallId}</code></p>
						<details class="token-details">
							<summary>FCM 토큰 (Firebase 콘솔 직접 테스트용)</summary>
							<textarea
								class="token-textarea"
								readonly
								rows="4"
								onclick={(e) => (e.target as HTMLTextAreaElement).select()}>{notifyToken}</textarea>
							<button
								class="btn btn-secondary"
								type="button"
								onclick={async () => {
									try {
										await navigator.clipboard.writeText(notifyToken ?? '');
										pushToast('토큰을 클립보드에 복사했습니다.');
									} catch {
										pushToast('복사 실패 — 텍스트 영역에서 직접 선택해주세요.', { kind: 'error' });
									}
								}}
							>
								토큰 복사
							</button>
						</details>
					{/if}
					<div class="btn-row">
						<button class="btn btn-secondary" onclick={onLocalTest} disabled={notifyBusy}>
							로컬 테스트 알림
						</button>
						<button class="btn btn-secondary" onclick={onFcmTest} disabled={notifyBusy}>
							{notifyBusy ? '...' : 'FCM 테스트 푸시'}
						</button>
						<button class="btn btn-secondary" onclick={onForceResubscribe} disabled={notifyBusy}>
							{notifyBusy ? '...' : 'Force 재구독'}
						</button>
						<button class="btn btn-secondary" onclick={onDisableNotify} disabled={notifyBusy}>
							알림 끄기
						</button>
					</div>
					<p class="info-text small">
						로컬 테스트는 서비스워커가 직접 띄우는 알림(FCM 우회). FCM 테스트는 서버를 거쳐
						실제 푸시 채널로 옴. <strong>Force 재구독</strong>은 기존 push subscription 을 완전히
						끊고 새로 만듦 — Push 구독 진단에서 "구독 존재: false"인 경우 이걸로 해결.
					</p>
				{:else}
					<p class="info-text">
						이 기기에서 알림을 받으려면 활성화가 필요합니다. 클릭하면 브라우저 권한 팝업이 뜹니다.
					</p>
					<button
						class="btn btn-primary"
						onclick={onEnableNotify}
						disabled={notifyBusy || !notifyScheduleGuid}
					>
						{notifyBusy ? `진행 중: ${notifyStep}` : '알림 활성화'}
					</button>
					{#if !notifyScheduleGuid}
						<p class="info-text small">먼저 위에서 일정 노트를 지정해주세요.</p>
					{/if}
					{#if notifyBusy && notifyStep}
						<p class="info-text small">현재 단계: <code>{notifyStep}</code></p>
					{/if}
				{/if}
			</section>

		{:else if activeTab === 'guide'}
			<!-- ── 가이드 탭 ───────────────────────────────────────────────── -->
			<section class="section">
				<p class="info-text">
					이 노트앱의 노트 형식 규칙과 브라우저/환경 요구사항을 정리한 페이지입니다. 새 기기에서
					처음 쓸 때 한 번씩 훑어보세요. 카테고리는 아래 탭으로 전환합니다.
				</p>
			</section>

			<nav class="guide-subtabs" aria-label="가이드 카테고리">
				{#each guideSubTabs as t (t.id)}
					<button
						type="button"
						class="guide-subtab"
						class:active={guideSubTab === t.id}
						aria-current={guideSubTab === t.id ? 'page' : undefined}
						onclick={() => (guideSubTab = t.id)}
					>
						{t.label}
					</button>
				{/each}
			</nav>

			{#if guideSubTab === 'notes'}
			<section class="section">
				<h2>구조화 노트 형식</h2>
				<p class="info-text">
					아래 노트들은 본문이 정해진 형식을 따를 때만 특수 기능이 동작합니다. 형식이 깨지면
					일반 노트로 떨어집니다.
				</p>

				<details class="guide-card" open>
					<summary>터미널 노트 — SSH 세션을 노트로 열기</summary>
					<p class="info-text">
						본문 1–3줄이 메타데이터로 인식되면 노트가 터미널 화면으로 열립니다. 4번째 자유 단락이
						있으면 일반 노트로 떨어집니다.
					</p>
					<pre class="snippet">ssh://[user@]host[:port]
bridge: wss://your-bridge.example.com
spectate: &lt;tmux-session-name&gt;

connect:
&nbsp; - 접속 직후 자동 실행할 명령
pinned:
&nbsp; - 오래 두고 볼 명령 (히스토리에서 분리)
history:
&nbsp; - 자주 쓰는 명령</pre>
					<ul class="guide-list">
						<li><code>bridge:</code> — 이 노트 전용 브릿지 URL(없으면 설정 → 터미널 기본값 사용).</li>
						<li><code>spectate:</code> — tmux 세션 관전 모드. 데스크탑에서 활성 페인만 따라감.</li>
						<li>자격증명은 노트에 쓰지 않습니다. 인증은 브릿지 Bearer 토큰 + ssh 키.</li>
						<li><code>ssh://localhost</code>은 컨테이너 안 셸, <code>ssh://user@localhost</code>은 호스트 sshd. 다릅니다.</li>
					</ul>
				</details>

				<details class="guide-card">
					<summary>일정 노트 — 푸시 알림 받기</summary>
					<p class="info-text">
						설정 → 알림에서 일정 노트로 지정한 노트만 푸시 대상이 됩니다. <code>N월</code> 헤더
						아래 한글 날짜 리스트 아이템으로 적습니다.
					</p>
					<pre class="snippet">5월
&nbsp; - 5월 15일 (금): 점심 약속
&nbsp; - 5월 16일 (토) 14:00: 회의
&nbsp; - 5월 20일 09:30: 병원</pre>
					<ul class="guide-list">
						<li>모든 항목 → 당일 <strong>07:00</strong>에 일괄 알림.</li>
						<li>시간이 있는 항목은 추가로 <strong>1시간 전</strong>과 <strong>해당 시각</strong>에도 알림.</li>
						<li>월요일 07:00에 주간 요약, 매월 1일 07:00에 월간 요약.</li>
						<li>요일은 자동 채워집니다(자동 요일 플러그인).</li>
						<li>여러 기기에서 같은 알림을 받으려면 <strong>각 기기마다 알림을 활성화</strong>해야 합니다(Dropbox 동기화로는 안 됨).</li>
					</ul>
				</details>

				<details class="guide-card">
					<summary>일정 노트 — 보내기 / 스킵 버튼 + 반복 마커</summary>
					<p class="info-text">
						일정 노트에서 <kbd>Ctrl</kbd>(모바일은 툴바의 <code>Ctrl</code> 고정)을 누르면 각
						리스트 아이템 오른쪽에 <strong>스킵</strong>·<strong>보내기</strong> 버튼이 나타납니다.
						<strong>보내기</strong>는 그 항목을 히스토리 노트로 옮기고, <strong>스킵</strong>은
						히스토리로 보내는 단계를 건너뜁니다.
					</p>
					<pre class="snippet">5월
&nbsp; - 25*(수) 가스점검      ← 월간 반복 (다음 달 25일)
&nbsp; - 15(수*) 분리수거       ← 주간 반복 (+1주)
&nbsp; - 8(금**) 격주 청소      ← 2주 반복 (+2주, * 개수 = 주)
&nbsp; - 3(금) 등산            ← 마커 없음 (1회성)</pre>
					<ul class="guide-list">
						<li><strong>보내기</strong> — 항목을 히스토리 노트로 보냅니다. 반복 마커가 있으면
							다음 주기 날짜로 복제본도 함께 만들어 둡니다.</li>
						<li><strong>스킵</strong> — 마커 없는 1회성 항목은 <strong>그냥 삭제</strong>합니다.
							반복 마커가 있으면 삭제·히스토리 이동 없이 <strong>다음 주기로 옮기기만</strong> 합니다.
							(이번 주기를 거른다는 뜻)</li>
						<li>반복 마커는 위치로 구분 — <code>25*(수)</code>처럼 <strong>일 번호 옆 *</strong>는
							월간, <code>15(수*)</code>처럼 <strong>요일 뒤 *</strong>는 주간(<code>*</code> 개수 = 주).</li>
						<li>보내기·스킵 모두 한 번의 <kbd>Ctrl</kbd>+<kbd>Z</kbd>로 되돌릴 수 있습니다.</li>
					</ul>
				</details>

				<details class="guide-card">
					<summary>슬립노트 — 노트 체인 형식</summary>
					<p class="info-text">
						<code>[0] Slip-Box</code> 노트북 안의 노트들이 <code>이전</code> / <code>다음</code> 링크로
						단방향 연결 리스트를 이룹니다. 형식이 엄격하므로 <code>/admin/sleepnote</code>에서 검증
						가능합니다.
					</p>
					<pre class="snippet">제목 라인

이전: [[이전-슬립노트-제목]]
다음: [[다음-슬립노트-제목]]

이론
&nbsp; - …
실용
&nbsp; - …
기록
&nbsp; - …</pre>
					<ul class="guide-list">
						<li>인덱스 노트(<code>1c97d161-…</code>) 가 체인의 루트. TopNav의 "슬립노트" 항목이 여기로 이동.</li>
						<li>체인 편집은 화살표 위젯의 액션 버튼(추가/잘라내기/연결/붙여넣기) 사용 권장.</li>
					</ul>
				</details>

				<details class="guide-card">
					<summary>일기 노트 — reMarkable OCR 자동 생성</summary>
					<p class="info-text">
						reMarkable 태블릿 → Pi → 데스크탑 OCR → Firestore 파이프라인으로 자동 생성됩니다.
						<code>system:notebook:일기</code> 태그가 붙고 제목에 <code>[&lt;rm-page-uuid&gt;]</code>
						마커가 들어갑니다.
					</p>
					<ul class="guide-list">
						<li><strong>중요:</strong> 제목의 <code>[&lt;uuid&gt;]</code> 마커가 보호 신호입니다. 교정 후 마커를 지우면
							같은 페이지를 다시 OCR해도 그 노트는 덮어쓰이지 않습니다.</li>
						<li>일기가 앱에서 안 보이면 <strong>설정 → 동기화 설정 → 파이어베이스 실시간 노트 동기화</strong>를
							먼저 확인하세요(기본 OFF).</li>
					</ul>
				</details>

				<details class="guide-card">
					<summary>리마커블 수동 업로드 (<code>리마커블::</code>)</summary>
					<p class="info-text">
						리마커블 → Pi inbox 동기화는 리마커블 위 1분 cron이 자동으로 처리합니다(변경
						없으면 skip). 이 버튼은 그 1분을 안 기다리고 데스크탑 OCR 파이프라인을 즉시
						깨우는 트리거입니다. 본문 첫 줄을 <code>리마커블::제목</code> 형식으로 시작하면
						노트 상단에 "📥 업로드" 버튼이 나타납니다.
					</p>
					<pre class="snippet">리마커블::오늘 일기
폴더: Diary</pre>
					<ul class="guide-list">
						<li><code>폴더:</code> 헤더는 로그용 라벨일 뿐, 실제 페이지 선택은 cron이 담당.</li>
						<li>같은 노트에서 여러 번 클릭 가능. 누를 때마다 한 줄 로그가 누적됩니다.</li>
						<li>가장 최근에 그린 페이지가 아직 Pi에 안 도착했다면(1분 미만), 다음 cron 사이클 후 자동 OCR 처리됩니다 — 다시 누를 필요 없음.</li>
						<li><strong>로컬 네트워크 전제</strong> — 외부망에서는 트리거 실패. 다만 리마커블 cron은 그대로 돌고 있으므로 네트워크 복귀 시 자연스럽게 동기화됩니다.</li>
						<li>결과 노트는 기존 일기 파이프라인과 동일하게 자동 생성됩니다 (제목 형식 변경 없음).</li>
					</ul>
				</details>

				<details class="guide-card">
					<summary>OCR 노트 — 이미지 텍스트 추출 + 한국어 번역</summary>
					<p class="info-text">
						본문 첫 줄이 <code>ocr://claude</code> 또는 <code>ocr://got-ocr2</code> 시그니처면 이미지를
						붙여넣을 때 자동으로 텍스트를 추출하고 한국어로 번역합니다. 결과는
						<code>[원문]</code> / <code>[번역]</code> 두 블록으로 삽입됩니다.
					</p>
					<pre class="snippet">ocr://claude
effort: high

[이미지 붙여넣기]</pre>
					<ul class="guide-list">
						<li><strong>기본 백엔드는 Claude</strong> — 데스크탑 claude-service의 구독 OAuth 사용. 토큰당 추가 과금 없음.</li>
						<li><strong>한 번 호출로 OCR + 한국어 번역</strong> 동시 처리. 결과는 <code>[원문]</code> / <code>[번역]</code> 두 블록.</li>
						<li><strong>옵션 헤더</strong> — <code>model: claude-opus-4-7</code>, <code>effort: low|medium|high|xhigh|max</code>, <code>system: …</code>.</li>
						<li><strong>기존 <code>ocr://got-ocr2</code> 노트도 계속 작동</strong>. ocr-service(GOT-OCR2) 경로가 살아 있음.</li>
					</ul>
				</details>

				<details class="guide-card">
					<summary>노트 → 리마커블 PDF 송출 (컨텍스트 메뉴)</summary>
					<p class="info-text">
						데스크탑 노트 윈도우에서 우클릭 → "리마커블로 보내기" 를 누르면 현재 노트를
						PDF 로 변환해 리마커블의 지정 폴더에 떨굽니다. 마크다운 형식(볼드/이태릭/리스트/
						내부링크)은 그대로 유지되며, 본문 안 내부 링크는 PDF 안 다른 섹션으로 점프하는
						클릭형 하이퍼링크로 변환됩니다.
					</p>
					<ul class="guide-list">
						<li><strong>링크 깊이 옵션</strong> — 0 (이 노트만) / 1 (직접 링크된 노트까지) /
							2 / 3. 같은 노트가 여러 경로로 연결되어 있어도 한 번만 포함됩니다(dedup).</li>
						<li><strong>기본 폴더</strong> — <button type="button" class="link-btn" onclick={() => (activeTab = 'remarkable')}>설정 → 리마커블 탭</button>
							에서 별칭별로 한 번 지정. 매 송출 시 자동으로 채워지고, 모달에서 별칭만
							바꾸면 즉시 다른 별칭으로 보냅니다.</li>
						<li><strong>한글 폰트</strong> — NanumGothic (OFL). <code>npm run prefetch:fonts</code>
							가 빌드 시 자동으로 받아 <code>static/fonts/</code> 에 채우며, 클라이언트는
							첫 송출 때 한 번 fetch → IDB 캐시. 이후 송출에 추가 네트워크 부담 없음.</li>
						<li><strong>이미지</strong> — v1 에서 본문 이미지는 PDF 에 들어가지 않습니다 (텍스트
							중심 메모를 빠르게 빼내는 데 초점). 후속 업데이트 예정.</li>
						<li><strong>전제</strong> — 브릿지가 reMarkable 호스트와 SSH 접속 가능해야 합니다
							(<code>remarkable.json</code> 등록 + 키 + <code>known_hosts</code>). 송출 시 브릿지가
							<code>{`/home/root/.local/share/remarkable/xochitl/`}</code> 에 PDF + 메타를 떨구고
							<code>systemctl restart xochitl</code> 로 즉시 표시되게 합니다.</li>
					</ul>
				</details>

				<details class="guide-card">
					<summary>리마커블 배경화면 노트 — 태블릿 화면 바꾸기</summary>
					<p class="info-text">
						본문 <strong>둘째 줄</strong>이 <code>remarkable://&lt;별칭&gt;</code> 시그니처면 노트
						상단에 "리마커블 배경화면" 액션바가 나타납니다. 첫 줄은 자유로운 노트 제목이며,
						둘째 줄에 시그니처가 없으면 일반 노트로 떨어집니다.
					</p>
					<pre class="snippet">내 리마커블 배경
remarkable://rm2

절전 중
https://www.dropbox.com/…/suspended.png

부팅 중
https://www.dropbox.com/…/starting.png</pre>
					<ul class="guide-list">
						<li>섹션 라벨 5종 — <code>절전 중</code> / <code>부팅 중</code> / <code>전원 꺼짐</code> /
							<code>재부팅 중</code> / <code>배터리 없음</code>. 라벨 아래 첫 http(s) 링크가 그 화면 이미지.</li>
						<li>액션바의 <strong>적용</strong> 버튼으로 전송. 이미지는 브릿지에서 흑백 ·
							1404×1872로 자동 변환됩니다. "절전 중"을 바꾸면 태블릿의 xochitl이 자동 재시작됩니다.</li>
						<li>인증은 터미널 브릿지와 동일(Bearer 토큰 + ssh 키). 자격증명은 노트에 쓰지 않습니다.</li>
						<li>브릿지에 reMarkable 호스트 설정(<code>remarkable.json</code>)이 있어야 하며,
							<code>&lt;별칭&gt;</code>은 그 설정의 키와 일치해야 합니다. 설정이 없으면
							<strong>"브릿지에 리마커블 설정이 없습니다"</strong>(503) 오류가 납니다.</li>
					</ul>
				</details>

				<details class="guide-card">
					<summary>자동화 노트 (자동화::)</summary>
					<p class="info-text">
						제목이 <code>자동화::&lt;명령&gt;</code> 인 노트는 「⟳ 실행」 버튼을 띄웁니다. 누르면
						데스크탑에 등록된 스크립트가 실행되고, 결과(<code>{`{프로젝트명: CSV}`}</code>)로
						<code>DATA::&lt;프로젝트명&gt;</code> 노트의 CSV 블록이 갱신됩니다(없으면 생성). 실행 내역은
						이 노트에 리스트로 쌓입니다.
					</p>
					<pre class="snippet">자동화::loc-history

⟳ 실행

- 2026-06-02 15:30 — tomboy·robotC 갱신
- 2026-06-01 09:12 — tomboy 갱신, robotC 실패(타임아웃)</pre>
					<ul class="guide-list">
						<li>실행할 스크립트·경로는 <strong>데스크탑 automation-service의 registry</strong>(<code>~/.config/tomboy-automation.json</code>)에만 정의됩니다. 노트는 명령 id만 보냅니다.</li>
						<li>선행조건: 터미널 브릿지 설정 + 데스크탑 automation-service 실행(자세히는 <code>automation-service/deploy/README.md</code>).</li>
						<li>결과의 각 프로젝트명마다 <code>DATA::</code> 노트를 찾아 갱신하므로, 한 번에 여러 데이터 노트를 갱신할 수 있습니다.</li>
					</ul>
				</details>
				<details class="guide-card">
					<summary>노트 수 자동화 (자동화::note-count-…)</summary>
					<p class="info-text">
						생성일 기준으로 노트 <strong>증감(기간별 신규 생성 수)</strong>을 카테고리(노트북)별로 세는
						<strong>로컬</strong> 자동화입니다. 「⟳ 실행」을 누르면 브릿지 없이 브라우저에서 바로 계산해
						<code>DATA::…</code> 노트에 CSV로 적고, 라인차트 노트를 만듭니다(없을 때만 생성). 집계 단위에
						따라 자동화가 2개입니다.
					</p>
					<pre class="snippet">자동화::note-count-yearly        ← 연도별
자동화::note-count-monthly       ← 올해 월별
자동화::note-count-monthly-2025  ← 특정 연도(2025) 월별

⟳ 실행

────────────
DATA::note-count-yearly
year,[0] Slip-Box,[1] 프로젝트A
2024,40,12
2025,55,9
2026,18,3

DATA::note-count-2026
month,[0] Slip-Box,[1] 프로젝트A
2026-01,12,2
2026-02,3,0
2026-03,5,1</pre>
					<ul class="guide-list">
						<li><strong>note-count-yearly</strong> → <code>DATA::note-count-yearly</code> + 「연도별 노트 수」
							차트. 행 = 연도(가장 오래된 노트 연도 ~ 올해).</li>
						<li><strong>note-count-monthly[-YYYY]</strong> → <code>DATA::note-count-&lt;연도&gt;</code> +
							「&lt;연도&gt;년 월별 노트 수」 차트. 연도를 안 적으면 올해, <code>-2025</code> 처럼 붙이면 그
							연도. 행 = 1월~12월(올해는 이번 달까지).</li>
						<li>세는 카테고리: <code>[0] Slip-Box</code> 노트북과 <code>[1]</code> 로 시작하는 모든
							노트북. 각 카테고리가 <strong>한 컬럼</strong>이 되고, 새 <code>[1]…</code> 노트북이
							생기면 다음 실행 때 자동으로 컬럼이 늘어납니다.</li>
						<li>값은 <strong>누적이 아니라 그 기간의 신규 생성 수</strong>입니다. 삭제된 노트·템플릿은
							제외되며(삭제는 추적하지 않으므로 감소는 잡히지 않음), 로컬 전용이라 데스크탑
							automation-service·브릿지 설정이 필요 없습니다.</li>
						<li>차트 노트는 처음 한 번만 생성됩니다. 차트는 데이터 노트를 실시간으로 읽으므로 이후
							실행은 <code>DATA::…</code> 만 갱신해도 차트가 따라 갱신됩니다(차트 설정을 직접 바꿔도
							덮어쓰지 않음).</li>
					</ul>
				</details>
				<details class="guide-card">
					<summary>음악 노트 — <code>음악::</code> 플레이리스트 재생</summary>
					<p class="info-text">
						제목을 <code>음악::제목</code> 으로 시작하면 음악 노트가 되고, <strong>노트 맨 위</strong>에
						재생 컨트롤 배너가 고정됩니다(재생/정지·이전/다음·<strong>반복</strong>·<strong>랜덤
						섞기</strong>·탐색). 배너는 텍스트 영역과 <strong>별개 컴포넌트</strong>라 눌러도 본문 커서가
						잡히지 않고, 스크롤해도 위에 붙어 있습니다. <code>플레이리스트: 설명</code> 줄 앞
						체크박스를 <strong>체크</strong>하면(<code>[x]플레이리스트: …</code>) 그 줄 다음 리스트가
						플레이리스트가 되어 곡 <strong>제목만</strong> 깔끔하게 보이고, <strong>해제</strong>하면
						(<code>[ ]플레이리스트: …</code>) 다시 일반 텍스트 목록으로 돌아갑니다. 한 노트의 켜진
						플레이리스트는 문서 순서대로 이어 재생됩니다.
					</p>
					<pre class="snippet">음악::주말 플레이리스트

[x]플레이리스트: 아침
&nbsp; - 곡 제목
&nbsp; &nbsp; - https://example.com/song.mp3
&nbsp; - https://example.com/another.mp3

[ ]플레이리스트: 저녁  (체크 해제 → 그냥 텍스트)
&nbsp; - https://example.com/evening.mp3

SUNO:https://suno.com/playlist/&lt;id&gt;  (가져오기 → 플레이리스트 블록)</pre>
					<ul class="guide-list">
						<li><strong>체크박스 토글</strong>: 줄 앞에 <code>[x]</code> 를 입력하면 플레이리스트 모드,
							<code>[ ]</code> 면 텍스트 모드. 체크박스 없는 <code>플레이리스트:</code> 줄은 켜진
							것으로 봅니다.</li>
						<li>플레이리스트 모드(체크 ON)에선 URL이 숨고 곡 제목(없으면 파일명)만 보입니다.
							이 모드에선 곡 줄에 <strong>커서가 가지 않고</strong>, 줄을 <strong>탭/클릭하면 그 곡이
							재생</strong>됩니다(재생 중인 곡을 다시 누르면 일시정지). <strong>제목·URL을 고치려면
							체크박스를 끄세요</strong> — 텍스트 모드로 돌아가 원래 줄을 자유롭게 편집할 수 있습니다.</li>
						<li><strong>플레이리스트 헤더 우측 ▶</strong> 버튼을 누르면 그 플레이리스트가 첫 곡부터
							재생됩니다.</li>
						<li>아이템 2가지 형식: <strong>제목(깊이1) + URL(깊이2)</strong>, 또는 제목을 모르면
							<strong>URL만(깊이1)</strong>.</li>
						<li>재생 중인 곡은 리스트 마커 대신 재생 아이콘(이퀄라이저)으로 표시됩니다.</li>
						<li>배너의 <strong>🔁 반복</strong>은 누를 때마다 끔→전체 반복→한 곡 반복으로 바뀌고,
							<strong>🔀 랜덤 섞기</strong>는 재생 순서를 무작위로 돌립니다(켜는 순간 지금 곡은 그대로).</li>
						<li><strong>재생은 전역에 하나</strong>입니다. 어느 노트에서 틀든, 열려 있는 모든 음악 노트의
							배너가 <strong>같은 재생 곡</strong>을 표시합니다. 아무것도 재생 중이 아니면 배너는 지금 보는
							노트의 첫 곡을 미리 보여주고, ▶ 로 그 노트를 시작합니다.</li>
						<li><strong>직접 오디오 파일 URL</strong>(mp3 등 브라우저가 재생 가능한 링크)을 재생합니다.</li>
						<li><strong>SUNO 재생목록 가져오기</strong>: <code>SUNO:&lt;재생목록 URL&gt;</code> 줄을 쓰면
							우측에 <b>가져오기</b> 버튼이 떠요. 누르면 Suno 공개 재생목록을 읽어 그 줄 <b>바로 아래</b>에
							<code>[x]플레이리스트: …</code> 블록(곡 제목 + 직접 재생 URL)을 만들어 바로 재생됩니다.</li>
						<li>Suno 곡은 <b>다운로드 없이 직접 링크</b>합니다 — 빠르고 데스크탑 서비스가 필요 없지만,
							Suno 에서 곡을 내리면 재생이 안 될 수 있어요. 선행: 브릿지 설정(터미널 탭).</li>
						<li>이미 가져온 줄은 버튼이 사라져요. <b>다시 가져오려면</b> 아래 플레이리스트 블록을 지우면
							버튼이 다시 떠요. 한 번에 최대 100곡.</li>
					</ul>
				</details>

				<details class="guide-card">
					<summary>음악추출:: — YouTube를 mp3로 모으기</summary>
					<p class="info-text">
						<code>음악추출::</code> 로 시작하는 노트는 작업대예요. 영상 URL이나 검색어를 리스트로
						적고 <b>⟳ 진행</b>을 누르면, 데스크탑에서 mp3로 추출해 브릿지에 저장하고 그 주소를 항목
						밑에 채워 줍니다. 추출된 곡은 일반 음악처럼 백그라운드·잠금화면 재생이 돼요.
					</p>
					<pre class="snippet">음악추출::내 라이브러리

- https://www.youtube.com/watch?v=…      (단일 곡: 불릿)
- Artist - Title                         (검색어도 가능)
https://www.youtube.com/playlist?list=…  (재생목록: 일반 줄)</pre>
					<ul class="guide-list">
						<li>⟳ 는 <b>결과가 아직 없는 항목만</b> 처리해요. 소스를 더 추가하고 다시 눌러도
							이미 받은 곡은 건너뜁니다.</li>
						<li>재생하려면 채워진 링크를 <code>음악::</code> 노트로 복사해 구성하세요(수동).</li>
						<li><b>재생목록/믹스</b>는 <b>불릿이 아닌 일반 텍스트 줄</b>에 URL을 적으세요. ⟳ 를 누르면
							전체 곡을 추출해 그 줄 <b>바로 아래</b>에 <code>[ ]플레이리스트: …</code> 블록(헤더+곡 목록)을
							만들어 줍니다. 그 블록을 통째로 복사해 <code>음악::</code> 노트에 붙이고 체크박스를 켜면 재생돼요.</li>
						<li>재생목록은 한 번에 <b>최대 50곡</b>까지 받고, 초과하면 앞 50곡만 받은 뒤 안내해요.</li>
						<li>유튜브 자동 <b>믹스(<code>RD…</code>)</b>는 접속할 때마다 곡이 조금씩 바뀌고 개수도 제한적이에요.
							한 가수 곡을 확실히 모으려면 정규 재생목록(<code>list=PL…</code> 또는 앨범
							<code>OLAK5uy…</code>)이 안정적입니다.</li>
						<li>선행: 데스크탑 <code>music-service</code> 실행 + 브릿지 <code>MUSIC_SERVICE_URL</code>
							설정. 브릿지 설정이 없으면 "브릿지 설정이 필요합니다", 데스크탑 서비스에 못 닿으면
							"음악 추출 서비스에 연결할 수 없습니다" 안내가 떠요.</li>
						<li>개인·자기 호스팅 도구입니다. <b>본인이 권리를 가진 콘텐츠</b>(내 업로드/CC/퍼블릭
							도메인)에만 사용하세요.</li>
					</ul>
				</details>
			</section>

			{:else if guideSubTab === 'editor'}
			<section class="section">
				<h2>에디터 본문 블록</h2>
				<p class="info-text">
					아래는 노트의 일부 영역에만 적용되는 인라인 블록 형식입니다. 한 노트 안에 여러 개를 섞을
					수 있고, 형식이 어긋나면 그 블록만 일반 문단으로 보입니다.
				</p>

				<details class="guide-card" open>
					<summary>표 (CSV / TSV) — 본문 안의 펜스 블록</summary>
					<p class="info-text">
						GitHub 마크다운과 같은 <strong>코드 펜스</strong>로 표를 그립니다. 본문 위에 떠 있는
						별도 형식이 아니라, 일반 문단들 위에 렌더링 레이어로 표가 얹히는 방식입니다.
						원본 텍스트는 그대로 보존되어 Tomboy XML로 라운드트립됩니다.
					</p>
					<pre class="snippet">```csv
헤더1, 헤더2, 헤더3
가, 나, 다
라, 마, 바
```</pre>
					<ul class="guide-list">
						<li>여는 펜스: <code>```csv</code> 또는 <code>```tsv</code>. 언어 태그는 대소문자 무관이며,
							태그 뒤에 다른 글자가 붙으면 펜스로 인식되지 않습니다(<code>```csv extra</code> ✗).</li>
						<li>닫는 펜스: 빈 <code>```</code> 한 줄. 닫기 전에 또 다른 여는 펜스가 나오면 첫 표는
							미완료로 간주되어 표 렌더가 적용되지 않습니다.</li>
						<li><strong>CSV</strong>: 쉼표(<code>,</code>)로 셀을 나누고 각 셀 양끝 공백을 트림합니다.</li>
						<li><strong>TSV</strong>: 탭(<code>\t</code>)으로 나누고 공백을 보존합니다. 탭만 있는 빈 행도
							데이터로 인정(예: <code>\t\t</code>는 빈 세 셀).</li>
						<li><strong>첫 행이 헤더</strong>입니다. 행마다 셀 개수가 달라도 그대로 렌더링됩니다(자동
							패딩 없음).</li>
						<li>셀 안의 <strong>굵게 · 기울임 · 내부/외부 링크 · 폰트 크기</strong> 등 마크는 보존됩니다.</li>
						<li>같은 노트에 여러 표를 둘 수 있고, 표와 일반 문단을 자유롭게 섞을 수 있습니다.</li>
					</ul>
					<p class="info-text">조작:</p>
					<ul class="guide-list">
						<li>표 좌측 상단의 체크박스 — 켜면 표로 렌더, 끄면 원본 펜스 문단으로 펼쳐 직접 편집.</li>
						<li><kbd>Ctrl</kbd>(또는 <kbd>Cmd</kbd>)을 누르고 있으면 표 외곽에 <strong>행 추가</strong> /
							<strong>열 추가</strong> + 버튼과 행·열 삭제 X 버튼이 나타납니다.</li>
						<li>셀을 더블 클릭하면 해당 셀만 인라인 편집됩니다. 한 셀을 고쳐도 같은 행 다른 셀의
							마크는 그대로 살아남습니다.</li>
					</ul>
				</details>

				<details class="guide-card">
					<summary>표 (마크다운) — 본문 안의 GFM 표</summary>
					<p class="info-text">
						GitHub 마크다운 표 문법을 그대로 씁니다. 펜스 없이, 헤더 줄 바로 아래에
						<strong>구분선 줄</strong>(<code>| --- | --- |</code>)이 있으면 자동으로 표로
						렌더됩니다. 원본 텍스트는 보존되어 Tomboy XML로 라운드트립됩니다.
					</p>
					<pre class="snippet">| 헤더1 | 헤더2 | 헤더3 |
| :--- | :--: | ---: |
| 가 | 나 | 다 |
| 라 | 마 | 바 |</pre>
					<ul class="guide-list">
						<li><strong>구분선 줄 필수</strong>: 헤더 다음 줄이 <code>| --- |</code> 형태여야 표로
							인식됩니다. 구분선이 없으면 일반 문단으로 보입니다.</li>
						<li><strong>정렬</strong>: 구분선에 콜론을 붙여 열을 정렬합니다 —
							<code>:---</code>(왼쪽), <code>:--:</code>(가운데), <code>--:</code>(오른쪽).</li>
						<li><strong>바깥 파이프는 선택</strong>: <code>| a | b |</code>와 <code>a | b</code> 모두
							인식되며, 셀 양끝 공백은 트림됩니다.</li>
						<li><kbd>Alt</kbd>+<kbd>T</kbd> — 커서 위치에 빈 2×2 표를 삽입합니다.</li>
						<li>셀 안의 <strong>굵게 · 기울임 · 링크</strong> 등 마크는 보존됩니다.</li>
						<li>⚠️ <strong><code>---</code> 한 줄만</strong> 있으면 표가 아니라
							<strong>세로 분할선(HR 분할)</strong>입니다. 표 구분선은 반드시 파이프를
							포함해야 합니다.</li>
					</ul>
					<p class="info-text">조작 (CSV/TSV 표와 동일):</p>
					<ul class="guide-list">
						<li>표 좌측 상단 체크박스 — 켜면 표 렌더, 끄면 원본 마크다운으로 펼쳐 직접 편집.</li>
						<li><kbd>Ctrl</kbd>/<kbd>Cmd</kbd>을 누르고 있으면 행/열 추가 + 버튼과 삭제 X 버튼이
							나타납니다. 열을 추가·삭제하면 구분선 줄도 함께 맞춰집니다.</li>
						<li>셀 더블 클릭 — 해당 셀만 인라인 편집.</li>
					</ul>
				</details>

				<details class="guide-card">
					<summary>각주 (<code>[^N]</code>) — 참조 ↔ 설명 점프 + 미리보기</summary>
					<p class="info-text">
						본문에 <code>[^1]</code> 처럼 입력하면 작은 위첨자 <strong>참조 마커</strong>가 됩니다.
						같은 라벨을 줄 맨 앞에 둔 문단은 <strong>설명 마커</strong>(일반 크기)로, 참조와 설명이
						서로 짝이 되어 클릭으로 오갑니다. <code>[^N]</code> 텍스트는 Tomboy XML에 그대로
						보존됩니다.
					</p>
					<pre class="snippet">본문 중간에 각주를 답니다.[^1]

[^1] 줄 맨 앞에 같은 라벨을 두면 이 문단이 설명이 됩니다.</pre>
					<ul class="guide-list">
						<li><strong>설명 마커</strong>(줄 맨 앞 <code>[^N]</code>) 클릭 — 데스크탑·모바일 모두
							짝 참조로 즉시 스크롤 이동합니다.</li>
						<li><strong>참조 마커</strong>(본문 속 위첨자) — <strong>데스크탑</strong>은 마우스를 올리면
							설명 <strong>전문</strong>이 미리보기로 뜨고, 클릭하면 설명으로 이동합니다.</li>
						<li><strong>모바일</strong>에서 참조를 탭하면 설명 미리보기(최대 300자)와 <strong>이동</strong>
							버튼이 뜹니다. 버튼을 눌러야 이동하고, 바깥을 탭하거나 스크롤하면 닫힙니다.</li>
						<li>위첨자는 작아 탭이 어려우므로 <strong>모바일에서는 터치 영역을 넓혀</strong> 두었습니다.</li>
						<li>편집 중(<strong>키보드가 올라온 상태</strong>)에는 각주 탭이 미리보기·이동을 띄우지 않고
							일반 커서 배치로 동작합니다 — 넓힌 터치 영역을 잘못 눌러 편집이 끊기지 않게 하기
							위함입니다.</li>
						<li>짝을 찾지 못한 각주는 “설명을 찾을 수 없습니다” 안내가 표시됩니다.</li>
					</ul>
				</details>

				<details class="guide-card">
					<summary>각주를 Claude로 채우기</summary>
					<p class="info-text">
						각주 설명 칸에 요청을 적고 <code>@claude</code> 뒤에 공백을 입력하면,
						Claude가 본문 맥락을 읽어 그 각주 설명을 자동으로 채웁니다.
					</p>
					<pre class="snippet">좀 더 자세한 설명을 해줘 @claude </pre>
					<ul class="guide-list">
						<li>맥락은 <strong>본문 속 각주 참조 마커 위치까지</strong>만 전달됩니다(그 이후 본문·다른 각주는 제외).</li>
						<li>각주답게 <strong>300자 이내</strong>로 간결하게 작성하도록 유도합니다.</li>
						<li>데스크탑 <strong>claude-service</strong>가 켜져 있어야 합니다(채팅 노트와 동일 경로).</li>
						<li>생성 중 생각 과정이 각주 옆에 잠깐 표시되고, 완료되면 답변만 남습니다.</li>
						<li>실패하거나 중단하면 원래 요청 문구가 복원됩니다 — 끝 공백을 다시 입력해 재시도하세요.</li>
					</ul>
				</details>

				<details class="guide-card">
					<summary>차트 — 데이터 노트를 그래프로</summary>
					<p class="info-text">
						표 데이터를 <strong>막대·선·영역·분산</strong> 그래프로 그립니다. 데이터는
						<code>DATA::</code> 로 시작하는 별도 노트에 두고, 아무 노트에서나 차트 블록을
						작성해 불러옵니다. 차트 블록 맨 앞 체크박스를 <strong>켜면([x]) 차트만 보이고</strong>
						(제목 줄·설정 목록은 숨겨집니다), 다시 텍스트로 돌리려면 <strong>차트 좌측 상단의
						체크박스</strong>를 끄면([ ]) 설정 목록이 펼쳐집니다.
					</p>
					<pre class="snippet">DATA::매출
```csv
월, 매출, 비용
1월, 100, 60
2월, 120, 70
```

[x]Chart:bar 월별 매출
  • DATA::매출
  • y:매출, 비용
  • [x]범례, 값표시</pre>
					<ul class="guide-list">
						<li><strong>데이터 노트</strong>: 제목을 <code>DATA::데이터제목</code> 으로 시작하고, 본문에
							<code>```csv</code> / <code>```tsv</code> 펜스로 표를 넣습니다(여러 표 가능, 차트는 첫 표 사용).</li>
						<li><strong>차트 블록</strong>: <code>[ ]Chart:종류 차트제목</code>. 종류는
							<code>bar</code>(막대) · <code>line</code>(선) · <code>area</code>(영역) ·
							<code>scatter</code>(분산).</li>
						<li>블록 아래 <strong>첫 하위 항목 = 쓸 데이터 노트 제목</strong>(<code>DATA::…</code>).
							이후 하위 항목에 옵션을 콤마로 나열합니다.</li>
					</ul>
					<p class="info-text">옵션 — 축 · 데이터</p>
					<ul class="guide-list">
						<li><code>x:열이름</code> — x축으로 쓸 열 지정</li>
						<li><code>y:열1, 열2</code> — y축 값으로 쓸 열(여러 개 가능)</li>
						<li><code>묶기:N</code> — 데이터를 N개 구간으로 묶어 집계(binning)</li>
						<li><code>방식:평균|합계|최대|최소|개수</code> — 묶을 때 집계 방식(기본 평균)</li>
						<li><strong>표시 범위</strong>(체크박스로 택1): <code>[x]all</code> 전체 ·
							<code>[x]last:N</code> 마지막 N개 · <code>[x]first:N</code> 처음 N개</li>
					</ul>
					<p class="info-text">옵션 — 모양 · 라벨</p>
					<ul class="guide-list">
						<li><code>stacked</code> — 누적 그래프 / <code>곡선</code> — 선을 부드럽게(line·area)</li>
						<li><code>점표시</code> · <code>점크기:N</code> — 데이터 점 표시 / 점 크기</li>
						<li><code>색상:c1,c2</code> · <code>팔레트:이름</code> — 색 직접 지정 / 팔레트 선택</li>
						<li><code>범례</code> · <code>값표시</code> — 범례 / 각 값 숫자 라벨 표시</li>
						<li><code>x축:라벨</code> · <code>y축:라벨</code> — 축 제목</li>
						<li><code>y최소:N</code> · <code>y최대:N</code> — y축 범위 고정 / <code>높이:N</code> — 차트 높이(px)</li>
					</ul>
				</details>

				<details class="guide-card">
					<summary>체크박스 · 라디오 · 체크리스트 영역</summary>
					<p class="info-text">
						본문 어디서나 마커 텍스트를 적으면 자동으로 위젯 노드로 바뀝니다.
						세 가지 종류가 있고 각각 문법이 다릅니다.
					</p>
					<p class="info-text"><strong>1. 인라인 체크박스</strong> — <code>[ ]</code> / <code>[x]</code> /
						<code>[X]</code> 를 본문 어디든 타이핑하면 그 자리에 작은 체크박스 위젯이 만들어집니다.
						리스트 항목 안에서도 동작합니다.</p>
					<pre class="snippet">[x] 아침 약 먹기 [ ] 빨래
- 리스트 안에서도 [x] 됨</pre>
					<p class="info-text"><strong>2. 인라인 라디오</strong> — <code>( )</code> / <code>(o)</code> /
						<code>(O)</code>. 같은 문단에 여러 개가 있으면 한 개만 선택됩니다 (그룹 토글).</p>
					<pre class="snippet">아침: (o) 빵 ( ) 밥 ( ) 면</pre>
					<p class="info-text"><strong>3. 체크리스트 영역 (통째 체크박스)</strong> —
						<code>체크리스트:</code> 로 시작하는 문단 바로 뒤에 오는 리스트는 각 항목 전체가
						체크박스가 됩니다. 항목 앞에 <code>[[ ]]</code> / <code>[[X]]</code> (대괄호 두 겹)
						마커가 붙어 저장됩니다. 인라인 <code>[x]</code> 와 의미가 달라 문법도 구분됩니다.</p>
					<pre class="snippet">체크리스트:
- [[X]] 우유
- [[ ]] 빵
- [[ ]] 잡지</pre>
					<ul class="guide-list">
						<li>인라인 체크박스 / 라디오는 <strong>제목 줄에선 동작하지 않습니다</strong>. 본문에서만
							위젯으로 바뀝니다.</li>
						<li>단축키 <kbd>Alt</kbd>+<kbd>C</kbd> (체크박스) / <kbd>Alt</kbd>+<kbd>R</kbd> (라디오)
							로도 커서 위치에 삽입할 수 있습니다 — 단축키 탭 참고.</li>
						<li>영역 헤더는 정확히 <code>체크리스트:</code> 로 <strong>시작</strong>해야 합니다
							(<code>체크리스트: 장보기</code> 처럼 뒤에 부제목 가능). 헤더 직후 연속된 리스트들이
							모두 영역이 됩니다.</li>
						<li>영역 안 항목은 클릭으로 통째 체크 토글이 됩니다 — 마커 텍스트를 직접 지울 필요 없습니다.
							저장 시 <code>[[X]] </code> / <code>[[ ]] </code> 가 자동으로 붙고, 다시 열면 통째
							체크박스로 복원됩니다.</li>
						<li>같은 항목 안에 인라인 <code>[x]</code> 도 함께 둘 수 있습니다 — 항목 자체는 통째 체크,
							본문 일부에 추가 체크박스를 두는 식. 예: <code>[[X]] 1단계 [x] 첫 단추</code>.</li>
						<li>영역 헤더 없이 <code>[[X]]</code> 만 적으면 평문 텍스트로 남습니다 (의미 없음).</li>
					</ul>
				</details>

				<details class="guide-card">
					<summary>새 노트 — 제목 선택 / 본문 커서 자동 배치</summary>
					<p class="info-text">
						노트를 새로 만들면 바로 타이핑을 시작할 수 있도록 커서가 자동으로 배치됩니다.
						노트를 어떻게 만들었느냐에 따라 동작이 다릅니다.
					</p>
					<ul class="guide-list">
						<li><strong>제목 없이 만든 새 노트</strong>(상단 <code>+</code> 버튼 등) — 제목이 현재
							날짜·시각(<code>yyyy-mm-dd HH:mm</code>)으로 자동 생성되고, 그 <strong>제목 전체가
							선택된 상태</strong>로 열립니다. 키를 한 번 누르면 자동 날짜가 통째로 지워지고 입력한
							글자로 바뀝니다.</li>
						<li><strong>제목이 정해진 채로 만든 노트</strong>(선택 영역 → 노트 추출, "오늘" 날짜
							노트, 링크로 새 노트 생성 등) — 커서가 <strong>세 번째 줄</strong>(플레이스홀더
							역할을 하는 둘째 줄 다음)에 놓여 바로 본문을 쓸 수 있습니다.</li>
						<li>이 자동 배치는 <strong>노트를 새로 만들 때만</strong> 적용됩니다. 기존 노트를 다시
							열 때는 커서가 자동으로 움직이지 않습니다.</li>
					</ul>
				</details>

				<details class="guide-card">
					<summary>수평선 (<code>---</code>) — 섹션 구분 · 접기 · 나란히 보기</summary>
					<p class="info-text">
						본문에 <code>---</code>(대시 3개 이상)만 있는 단락은 가로 구분선이 됩니다.
						구분선 아래 내용은 하나의 <strong>섹션</strong>이 되어, 구분선 우측 끝의 작은
						<code>−</code> / <code>+</code> 버튼 또는 <strong>구분선 자체를 클릭</strong>해서
						접거나 펼칠 수 있습니다.
					</p>
					<pre class="snippet">제목
2026-06-02

인트로 문단 (첫 수평선 위 — 접기 불가)
---                          [−]
섹션 첫 블록 (접으면 이 줄만 한 줄로 표시)
나머지 내용은 접힌 동안 숨겨짐
---                          [−]
다음 섹션 …</pre>
					<ul class="guide-list">
						<li><strong>접기</strong> — <code>−</code> 버튼이나 구분선을 누르면 해당 섹션의 첫 블록만 한 줄로
							클램프되어 보이고(말줄임표) 나머지 블록은 숨겨집니다. <code>+</code> 버튼 또는 구분선을
							다시 눌러 펼칩니다.</li>
						<li>섹션 = 구분선 바로 아래부터 다음 구분선(또는 노트 끝)까지. 첫 구분선 위 영역과
							제목/날짜 줄은 접기 대상이 아닙니다.</li>
						<li>접기 상태는 <strong>이 기기(브라우저)에만</strong> 저장됩니다 — 노트 내용과 동기화에는
							영향이 없습니다.</li>
						<li>모바일 · 데스크탑 모두 동작합니다.</li>
						<li><strong>나란히 보기(세로 칼럼 분할)와는 동시에 쓸 수 없습니다</strong> — 칼럼 분할이
							활성인 동안 접기 버튼이 숨겨지고, 접힌 섹션이 있는 동안 Ctrl+클릭 분할 토글이
							무시됩니다. 분할 기능의 브라우저 요구사항은
							<button type="button" class="link-btn" onclick={() => (guideSubTab = 'env')}>환경 탭</button>을 참고하세요.</li>
						<li>숨겨진 내용도 전체 선택 · 복사 · 검색에는 그대로 포함됩니다 — 보기만 접힐 뿐 내용은
							그대로 남아 있습니다.</li>
					</ul>
				</details>

				<details class="guide-card">
					<summary>프로세스 블록 — 멀티스테이지 칸반 (<code>Process:</code> … <code>Complete:</code>)</summary>
					<p class="info-text">
						<kbd>Alt</kbd>+<kbd>P</kbd> 로 삽입합니다. <code>Process:</code> 로 시작하는 문단부터
						<code>Complete:</code> 문단까지가 한 블록이고, 사이의 문단들이 각각 <strong>단계(칸반
						컬럼)</strong>가 됩니다. 단계 문단 뒤의 리스트가 그 단계의 아이템 목록입니다.
					</p>
					<pre class="snippet">Process: 회사 이전
- 짐 싸기
  - 책상 정리
    - [[X]] 모니터 분리
    - [[ ]] 서랍 비우기
설치
Complete:</pre>
					<ul class="guide-list">
						<li><kbd>Alt</kbd>+<kbd>P</kbd> 는 <code>Process: 작업 이름</code> + <code>Complete:</code>
							두 줄만 삽입합니다 — 단계 문단과 아이템 리스트는 직접 타이핑하세요.</li>
						<li><code>Complete:</code> 문단이 <strong>반드시 있어야</strong> 블록으로 인식됩니다. 없으면
							전부 일반 문단입니다.</li>
						<li><kbd>Ctrl</kbd>(또는 모바일 "Ctrl 고정")을 누른 채 아이템에 마우스를 올리면
							<strong>이전</strong>/<strong>다음</strong> 버튼이 나타나 인접 단계로 이동합니다.</li>
						<li><strong>깊이 1</strong> 아이템(카드)은 하위 항목까지 통째로 이동. <strong>깊이 2</strong>
							아이템은 개별 이동 — 대상 단계에서 같은 카테고리 라벨을 찾아 들어가고, 없으면 자동
							생성됩니다.</li>
						<li><strong>깊이 3</strong> 아이템은 <strong>체크박스</strong>입니다 — 이동 버튼 대신 클릭으로
							체크 토글. 개별로 보내기엔 너무 작은 세부 진행 단계 체크용. 저장 시
							<code>[[ ]]</code> / <code>[[X]]</code> 마커가 자동으로 붙습니다 (체크리스트 영역과 같은
							문법).</li>
						<li>블록 안의 <strong>빈 줄</strong>이나 <code>---</code> 구분선은 무시됩니다 — 단계로 취급되지
							않고, 아이템 이동도 다음에 보이는 실제 단계 문단 아래로 갑니다.</li>
					</ul>
				</details>

				<details class="guide-card">
					<summary>=== 고정 헤더 — 위쪽을 상단에 고정</summary>
					<p class="info-text">
						한 라인에 단독으로 <code>===</code>(등호 3개 이상)를 두면 굵은 수평선이 그려지고,
						그 선보다 <strong>위쪽 내용이 스크롤해도 항상 상단에 고정</strong>되는 헤더가 됩니다.
						고정된 헤더를 누르면 문서 맨 위로 이동합니다.
					</p>
					<pre class="snippet">제목 라인
===
여기부터 본문 (스크롤 영역)</pre>
					<ul class="guide-list">
						<li><code>===</code>는 <strong>제목 바로 다음 줄부터</strong> 인식됩니다(제목 줄 자체는 마커가 아님).</li>
						<li>한 문서에 <strong>하나만</strong> 적용됩니다. 두 개 이상이면 <strong>가장 위의 것만</strong> 고정 경계가 되고, 나머지는 그냥 굵은 선으로만 표시됩니다.</li>
						<li>헤더가 길면 화면의 일정 높이(약 40%)까지만 보이고 내부에서 스크롤됩니다.</li>
						<li>고정 헤더는 <strong>읽기 전용 미러</strong>입니다. 편집은 위로 스크롤해 원래 위치에서 하세요.</li>
						<li><code>===</code>는 노트 내용에 그대로 저장됩니다(별도 토글·동기화 설정 없음).</li>
					</ul>
				</details>

				<details class="guide-card">
					<summary>모바일 <code>Ctrl</code> / <code>Alt</code> 고정 — 키보드 없이 단축키</summary>
					<p class="info-text">
						모바일 하단 툴바의 <code>Ctrl</code> · <code>Alt</code> 버튼을 켜면 단축키 키패드가
						열려 데스크탑 단축키를 탭으로 쓸 수 있습니다(예: <kbd>Ctrl</kbd>+<kbd>D</kbd> 오늘 날짜,
						<kbd>Alt</kbd>+<kbd>→</kbd> 들여쓰기). 둘은 서로 배타적이라 하나를 켜면 다른 하나는 꺼집니다.
					</p>
					<ul class="guide-list">
						<li><strong>고정이 켜진 동안에는 노트를 탭해도 키보드가 올라오지 않습니다.</strong> 글자가
							아니라 단축키를 누르려는 상태이므로, 커서 위치만 잡고 키보드는 띄우지 않습니다.</li>
						<li>이미 키보드가 올라온 채로 고정을 켜면 키보드가 곧바로 내려갑니다 — 매번 손으로
							내릴 필요가 없습니다.</li>
						<li>커서 위치는 그대로 유지되므로, 원하는 곳을 탭해 커서를 옮긴 뒤 단축키 버튼을 누르면
							그 위치에 적용됩니다.</li>
						<li>다시 글자를 입력하려면 <code>Ctrl</code> / <code>Alt</code> 고정을 끄세요 — 키보드가
							정상적으로 돌아옵니다.</li>
						<li>전체 단축키 목록은 <strong>단축키</strong> 탭을 참고하세요.</li>
					</ul>
				</details>

				<details class="guide-card">
					<summary>이미지 복사 — 우클릭 / 길게 누르기</summary>
					<p class="info-text">
						노트 본문에 표시된 이미지를 클립보드로 복사합니다. 복사한 이미지는 다른 앱이나
						웹·PC에 그대로 붙여넣을 수 있습니다(일반적인 이미지 복사와 동일).
					</p>
					<ul class="guide-list">
						<li><strong>데스크탑</strong>: 이미지 위에서 <strong>우클릭</strong> → 메뉴.</li>
						<li><strong>모바일</strong>: 이미지를 <strong>길게 누르면</strong>(약 0.5초) 메뉴가 뜹니다.</li>
						<li>메뉴 항목 — <strong>이미지 복사</strong>(이미지 바이트를 클립보드로),
							<strong>이미지 주소 복사</strong>(이미지 URL 텍스트만).</li>
						<li>이미지를 <strong>탭/클릭</strong>하면 기존처럼 전체화면 뷰어가 열립니다. 뷰어 우측
							상단의 <strong>복사 · 주소</strong> 버튼으로도 복사할 수 있고, 뷰어 안에서도
							우클릭이 동작합니다.</li>
						<li>복사할 바이트는 <button type="button" class="link-btn" onclick={() => (activeTab = 'config')}>설정 탭의 이미지 캐시</button>에서
							가져오므로, 한 번 열어본 적 있는 이미지는 네트워크 없이 즉시 복사됩니다.</li>
					</ul>
				</details>
			</section>

			{:else if guideSubTab === 'env'}
			<section class="section">
				<h2>환경 / 호환성 요구사항</h2>
				<p class="info-text">이게 안 맞으면 해당 기능이 동작하지 않거나 깨져 보입니다.</p>

				<details class="guide-card">
					<summary>데스크탑 — 펼쳐보기로 열린 노트 한눈에 보기</summary>
					<p class="info-text">
						데스크탑 작업공간에서 노트 창이 여러 개 겹쳐 잘 안 보일 때
						<strong>F4</strong>(또는 왼쪽 레일의 <strong>펼쳐보기</strong> 버튼)를 누르면,
						현재 작업공간에 열린 노트들이 실제 크기 그대로 겹치지 않게, 빈 공간을 메우며 빼곡히
						정렬되어 한 화면에 펼쳐집니다. 다시 F4나 Esc로 닫습니다.
					</p>
					<ul class="guide-list">
						<li>화면을 빼곡히 채우려고 짧은 노트를 빈틈에 끼워 넣으므로, 정렬된 순서는 원래 창 위치와 다를 수 있습니다.</li>
						<li>오른쪽의 큰 스크롤바로 전체를 위아래로 훑어보고, 마우스 휠은 커서가 놓인 개별 노트의 내용을 스크롤합니다.</li>
						<li>읽기 전용입니다. 노트를 클릭하면 펼쳐보기가 닫히고 그 노트 창으로 이동합니다.</li>
						<li>현재 작업공간에 열린 노트만 대상입니다(설정/관리자 창과 다른 작업공간은 제외).</li>
						<li>지도 같은 일부 임베드는 미리보기에서 빈칸으로 보일 수 있습니다 — 클릭해 열면 정상입니다.</li>
					</ul>
				</details>

				<details class="guide-card" open>
					<summary>Firefox — 세로 칼럼 분할 활성화</summary>
					<p class="info-text">
						본문에 <code>---</code> 만 있는 단락에 <strong>Ctrl/Cmd+클릭</strong>하면 가로 구분선이
						세로 칼럼 분할로 토글됩니다. 이 기능은 <strong>Firefox 전용</strong>이며 다음 플래그를
						켜야 합니다.
					</p>
					<pre class="snippet">about:config
→ layout.css.grid-template-masonry-value.enabled
→ true</pre>
					<p class="info-text">
						플래그가 꺼져 있거나 다른 브라우저면 짧은 구분선 토막으로만 보입니다(런타임에서 감지해서
						높이 동기화는 자동 스킵).
					</p>
				</details>

				<details class="guide-card">
					<summary>iOS — PWA 설치가 푸시 알림의 전제조건</summary>
					<p class="info-text">
						iOS Safari에서 일정 푸시 알림을 받으려면 <strong>홈 화면에 추가</strong>해서 PWA로 설치해야
						합니다. 브라우저 탭에서는 푸시 구독이 유지되지 않습니다.
					</p>
					<ul class="guide-list">
						<li>Safari → 공유 → "홈 화면에 추가".</li>
						<li>설치한 PWA를 한 번 열어 설정 → 알림에서 권한을 허용.</li>
						<li>아이콘 PNG가 로드되어야 구독이 유지되므로 PWA 메타데이터 변경 시 재설치 권장.</li>
					</ul>
				</details>

				<details class="guide-card">
					<summary>음악 노트 — 잠금화면 백그라운드 재생</summary>
					<p class="info-text">
						<code>음악::</code> 노트에서 재생하면 화면을 꺼도 재생이 이어지고, OS 잠금화면에
						곡 정보와 재생/일시정지/이전/다음/탐색 컨트롤이 뜹니다. 한 곡이 끝나면 다음 곡을
						미리 받아둔 덕에 잠금 상태에서도 끊김 없이 자동으로 넘어갑니다.
					</p>
					<ul class="guide-list">
						<li><strong>홈 화면에 추가(PWA 설치)</strong>를 권장합니다 — 브라우저 탭보다 백그라운드
							재생이 안정적입니다.</li>
						<li><strong>Android</strong>: 잠금화면 컨트롤과 자동 넘김이 거의 네이티브처럼 동작합니다.</li>
						<li><strong>iOS</strong>: 잠금 컨트롤과 단일 곡 재생은 안정적이나, 잠금 상태 자동 넘김은
							iOS 버전에 따라 완벽히 보장되지는 않습니다(다음 곡이 안 넘어가면 한 번 깨워서
							재생을 눌러주세요).</li>
						<li>오프라인 저장은 아직 없습니다 — 곡은 네트워크에서 재생되며, 다음 곡만 미리 받아둡니다.</li>
					</ul>
				</details>

				<details class="guide-card">
					<summary>알림 권한 — 일정 푸시</summary>
					<p class="info-text">
						브라우저의 알림 권한과 별개로, 이 앱에서 "알림 활성화"를 눌러야 FCM 토큰이 등록됩니다.
						<button type="button" class="link-btn" onclick={() => (activeTab = 'notify')}>알림 탭</button>에서 처리하세요.
					</p>
				</details>

				<details class="guide-card">
					<summary>Firebase 실시간 노트 동기화 — 기본 OFF</summary>
					<p class="info-text">
						기본값은 꺼짐입니다. Dropbox 동기화는 백업 채널로 그대로 두고, 이 옵션은 다른 기기와의
						실시간 반영용입니다.
					</p>
					<ul class="guide-list">
						<li><strong>일기 OCR 노트가 앱에 보이려면 반드시 켜져 있어야 합니다</strong>(파이프라인이
							Firestore로 씁니다).</li>
						<li>다른 기기에서 일정 노트를 갱신해도 이게 켜져 있어야 같은 기기에서 푸시 스케줄이
							재계산됩니다.</li>
						<li><button type="button" class="link-btn" onclick={() => (activeTab = 'config')}>동기화 설정 탭</button>에서 토글.</li>
					</ul>
				</details>
			</section>
			{/if}

		{:else if activeTab === 'shortcuts'}
			<!-- ── 단축키 탭 ───────────────────────────────────────────────── -->
			<section class="section">
				<p class="info-text">
					코드에 실제로 등록된 단축키 목록입니다. 별도 표기가 없으면 에디터 안에서만 동작합니다.
					macOS에서는 <kbd>Ctrl</kbd> 대신 <kbd>Cmd</kbd>를 쓰세요.
				</p>
			</section>

			<section class="section">
				<h2>텍스트 서식</h2>
				<table class="shortcut-table">
					<tbody>
						<tr><td><kbd>Ctrl</kbd>+<kbd>B</kbd></td><td>굵게 (Bold)</td></tr>
						<tr><td><kbd>Ctrl</kbd>+<kbd>I</kbd></td><td>기울임 (Italic)</td></tr>
						<tr><td><kbd>Ctrl</kbd>+<kbd>S</kbd></td><td>취소선</td></tr>
						<tr><td><kbd>Ctrl</kbd>+<kbd>H</kbd></td><td>형광펜 (Highlight)</td></tr>
						<tr><td><kbd>Ctrl</kbd>+<kbd>M</kbd></td><td>고정폭 글꼴 (Monospace)</td></tr>
					</tbody>
				</table>
			</section>

			<section class="section">
				<h2>삽입</h2>
				<table class="shortcut-table">
					<tbody>
						<tr><td><kbd>Ctrl</kbd>+<kbd>D</kbd></td><td>오늘 날짜 (<code>yyyy-mm-dd</code>) 삽입 — 브라우저 북마크 단축키 가로챔</td></tr>
						<tr><td><kbd>Ctrl</kbd>+<kbd>Enter</kbd></td><td>현재 줄은 유지하고 아래에 빈 블록 추가</td></tr>
						<tr><td><kbd>Ctrl</kbd>+<kbd>O</kbd></td><td>TODO 블록 삽입 (2단계)</td></tr>
						<tr><td><kbd>Alt</kbd>+<kbd>P</kbd></td><td>프로세스 블록 삽입 (멀티스테이지 칸반) — <code>Process:</code> + <code>Complete:</code> 두 줄 삽입. <kbd>Ctrl</kbd> 누른 채 아이템 hover 시 <strong>이전</strong>/<strong>다음</strong> 단계 이동 버튼. 자세한 형식은 가이드 → 에디터 탭</td></tr>
						<tr><td><kbd>Alt</kbd>+<kbd>R</kbd></td><td>인라인 라디오 버튼 (<code>( )</code>) 삽입 — 클릭으로 선택/해제, 같은 줄의 라디오끼리 상호 배타. 제목 줄에서는 동작 안 함</td></tr>
						<tr><td><kbd>Alt</kbd>+<kbd>C</kbd></td><td>인라인 체크박스 (<code>[ ]</code>) 삽입 — 클릭으로 체크/해제. 제목 줄에서는 동작 안 함</td></tr>
						<tr><td><kbd>Ctrl</kbd>+<kbd>K</kbd></td><td>현재 줄(블록 또는 리스트 아이템) 통째로 삭제</td></tr>
					</tbody>
				</table>
			</section>

			<section class="section">
				<h2>리스트 / 들여쓰기</h2>
				<table class="shortcut-table">
					<tbody>
						<tr><td><kbd>Tab</kbd></td><td>리스트 안: 표준 들여쓰기(서브트리 통째로 이동) / 리스트 밖: 탭 문자 삽입</td></tr>
						<tr><td><kbd>Shift</kbd>+<kbd>Tab</kbd></td><td>표준 내어쓰기(서브트리 통째로 이동)</td></tr>
						<tr><td><kbd>Alt</kbd>+<kbd>→</kbd></td><td>외과적 깊이 ↑ — 자식은 절대 깊이 유지(리스트 밖이면 리스트 시작)</td></tr>
						<tr><td><kbd>Alt</kbd>+<kbd>←</kbd></td><td>외과적 깊이 ↓ — 자식은 절대 깊이 유지</td></tr>
						<tr><td><kbd>Alt</kbd>+<kbd>↑</kbd></td><td>리스트 아이템 위로 이동</td></tr>
						<tr><td><kbd>Alt</kbd>+<kbd>↓</kbd></td><td>리스트 아이템 아래로 이동</td></tr>
					</tbody>
				</table>
			</section>

			<section class="section">
				<h2>마우스 제스처</h2>
				<table class="shortcut-table">
					<tbody>
						<tr><td><kbd>Ctrl</kbd>+<kbd>Click</kbd> on <code>---</code></td><td>가로 구분선 ↔ 세로 칼럼 분할 토글 (Firefox + masonry 플래그 필요)</td></tr>
						<tr><td><kbd>Ctrl</kbd>+<kbd>Click</kbd> on 날짜 화살표</td><td>이전/다음 날짜 노트를 같은 창에서 열기(replace)</td></tr>
						<tr><td><kbd>Ctrl</kbd>+<kbd>Click</kbd> on 슬립노트 화살표</td><td>이전/다음 슬립노트를 같은 창에서 열기(replace)</td></tr>
						<tr><td>타이틀바 <strong>중클릭</strong></td><td>(데스크탑 모드) 윈도우 맨 뒤로 보내기</td></tr>
						<tr><td>우클릭</td><td>(데스크탑 모드) 잘라내기/복사/형식 복사/붙여넣기/오늘 날짜 등 컨텍스트 메뉴</td></tr>
					</tbody>
				</table>
			</section>

			<section class="section">
				<h2>데스크탑 모드 (<code>/desktop</code>)</h2>
				<table class="shortcut-table">
					<tbody>
						<tr><td><kbd>Ctrl</kbd>+<kbd>L</kbd></td><td>선택한 텍스트로 새 노트 만들기 (에디터 포커스 상태에서)</td></tr>
						<tr><td><kbd>Ctrl</kbd>+<kbd>[</kbd></td><td>이전 날짜/슬립노트로 이동 (현재 창을 교체)</td></tr>
						<tr><td><kbd>Ctrl</kbd>+<kbd>]</kbd></td><td>다음 날짜/슬립노트로 이동 (현재 창을 교체)</td></tr>
						<tr><td><kbd>Ctrl</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd></td><td>활성 노트를 위/아래로 스크롤</td></tr>
						<tr><td><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>←</kbd> / <kbd>→</kbd> / <kbd>↑</kbd> / <kbd>↓</kbd></td><td>인접 워크스페이스로 전환</td></tr>
						<tr><td><kbd>Esc</kbd></td><td>활성 윈도우/모달 닫기</td></tr>
						<tr><td><kbd>Ctrl</kbd>+<kbd>`</kbd></td><td>마지막으로 닫은 노트 다시 열기 (실수로 닫았을 때)</td></tr>
					</tbody>
				</table>
			</section>

			<section class="section">
				<h2>터미널 노트 — 보내기 팝업</h2>
				<table class="shortcut-table">
					<tbody>
						<tr><td><kbd>Enter</kbd></td><td>입력한 명령을 활성 페인으로 전송 (IME 조합 중 제외)</td></tr>
						<tr><td><kbd>Esc</kbd></td><td>팝업 닫기</td></tr>
					</tbody>
				</table>
				<p class="info-text">
					팝업의 빠른 키 버튼: <code>y</code>, <code>n</code>, <code>1</code>, <code>Enter</code>,
					<code>Esc</code>, <code>^C</code>, <code>PgUp</code>, <code>PgDn</code>.
				</p>
			</section>

			<section class="section">
				<h2>참고 — 자동화 (단축키 아님)</h2>
				<ul class="guide-list">
					<li><strong>자동 내부 링크</strong>: 본문에 다른 노트의 제목 문자열이 나타나면 자동으로 내부 링크 마크가 붙음(자기 자신 제외).</li>
					<li><strong>자동 요일</strong>: 일정 노트의 날짜 뒤에 요일이 비어 있으면 자동 채움.</li>
					<li><strong>자동 이미지 미리보기</strong>: <code>http(s)://…</code> 이미지 URL은 인라인 썸네일로 렌더.</li>
					<li><strong>제목 중복 방지</strong>: 같은 제목으로 저장 시 자동 거부(임포트/풀은 <code>(2)</code> 접미사).</li>
				</ul>
			</section>

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
		{:else if activeTab === 'claude'}
			<!-- ── Claude 탭 ───────────────────────────────────────────────── -->
			<section class="section">
				<h2>Claude 채팅 기본값</h2>
				<p class="info-text">
					새 <code>claude://</code> 채팅 노트의 헤더에 자동으로 채워지는 기본값입니다.
					노트 헤더에 값이 없으면 전송 시 이 값으로 대체됩니다. Claude 채팅 노트는
					항상 코딩 에이전트 프롬프트를 교체하고 도구를 끈 "클린 모드"로 동작합니다.
				</p>

				<h3 class="field-label">기본 시스템 프롬프트</h3>
				<textarea
					id="claude-default-system"
					class="path-input"
					rows="3"
					bind:value={claudeDefSystem}
				></textarea>

				<h3 class="field-label">기본 모델</h3>
				<input
					id="claude-default-model"
					class="path-input"
					type="text"
					placeholder="opus"
					bind:value={claudeDefModel}
				/>

				<h3 class="field-label">기본 effort</h3>
				<select id="claude-default-effort" class="path-input" bind:value={claudeDefEffort}>
					{#each CLAUDE_VALID_EFFORTS as lvl (lvl)}
						<option value={lvl}>{lvl}</option>
					{/each}
				</select>

				<div class="path-row" style="margin-top: 0.75rem;">
					<button class="btn-save" onclick={saveClaudeDefaults}>
						{claudeDefSaved ? '저장됨' : '저장'}
					</button>
				</div>
			</section>
		{:else if activeTab === 'remarkable'}
			<!-- ── 리마커블 탭 ───────────────────────────────────────────── -->
			<RemarkableSendSettings />
		{/if}
	</main>
</div>

<style>
	.settings-page {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	.btn-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 8px;
	}

	.token-details {
		margin-top: 12px;
	}

	.token-textarea {
		width: 100%;
		font-family: monospace;
		font-size: 0.75rem;
		padding: 6px 8px;
		margin: 8px 0;
		border: 1px solid var(--color-border, #ccc);
		border-radius: 4px;
		resize: vertical;
		word-break: break-all;
	}

	.diag-details {
		margin-top: 8px;
	}

	.diag-list {
		font-size: 0.8rem;
		padding-left: 16px;
		margin: 4px 0;
	}

	.diag-refresh {
		margin-left: 8px;
		padding: 2px 8px;
		font-size: 0.85rem;
		background: var(--color-bg-secondary, #f0f0f0);
		border: 1px solid var(--color-border, #ccc);
		border-radius: 4px;
		cursor: pointer;
	}

	.diag-list li {
		margin: 2px 0;
		word-break: break-all;
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

	.field-label {
		font-size: 0.85rem;
		font-weight: 600;
		margin: 12px 0 4px;
		color: var(--color-text-secondary);
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

	.snippet {
		background: #111;
		color: #cfe;
		padding: 8px;
		border-radius: 4px;
		font-size: 0.78rem;
		overflow-x: auto;
		white-space: pre;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	}

	/* ── 가이드 / 단축키 탭 ──────────────────────────────────────────── */

	/* 가이드 탭 내부 카테고리 sub-nav. 메인 settings-tabs (밑줄 active) 와 시각적으로
	   구분되도록 알약(pill) 형태로 디자인 — 메인 탭 vs 서브 탭 위계가 한 눈에 보임. */
	.guide-subtabs {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		margin-bottom: 20px;
	}

	.guide-subtab {
		flex: 0 0 auto;
		padding: 6px 14px;
		border: 1px solid var(--color-border, #ccc);
		background: transparent;
		border-radius: 999px;
		font-size: clamp(0.78rem, 2.2vw, 0.88rem);
		color: var(--color-text-secondary, #777);
		cursor: pointer;
		transition: color 0.1s, border-color 0.1s, background 0.1s;
		white-space: nowrap;
	}

	.guide-subtab:hover {
		color: var(--color-text, #111);
		border-color: var(--color-text-secondary, #777);
	}

	.guide-subtab.active {
		background: var(--color-primary, #d05b10);
		color: #fff;
		border-color: var(--color-primary, #d05b10);
		font-weight: 600;
	}

	.guide-card {
		border: 1px solid var(--color-border, #e5e5e5);
		border-radius: 8px;
		padding: 10px 14px;
		margin-bottom: 10px;
		background: var(--color-bg, #fff);
	}

	.guide-card > summary {
		cursor: pointer;
		font-weight: 600;
		font-size: 0.95rem;
		padding: 4px 0;
		color: var(--color-text);
		list-style: revert;
	}

	.guide-card[open] > summary {
		margin-bottom: 8px;
		border-bottom: 1px solid var(--color-border, #eee);
		padding-bottom: 8px;
	}

	.guide-card .snippet {
		margin: 8px 0;
	}

	.guide-list {
		padding-left: 20px;
		margin: 6px 0;
		font-size: 0.85rem;
		color: var(--color-text-secondary, #555);
		line-height: 1.55;
	}

	.guide-list li {
		margin: 4px 0;
	}

	.guide-list code,
	.guide-card code,
	.shortcut-table code,
	.info-text code {
		background: var(--color-bg-secondary, #f1f1f1);
		padding: 1px 5px;
		border-radius: 4px;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.85em;
	}

	.shortcut-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.88rem;
	}

	.shortcut-table td {
		padding: 7px 10px;
		border-bottom: 1px solid var(--color-border, #eee);
		vertical-align: top;
	}

	.shortcut-table tr:last-child td {
		border-bottom: none;
	}

	.shortcut-table td:first-child {
		white-space: nowrap;
		width: 1%;
		color: var(--color-text);
	}

	.shortcut-table td:last-child {
		color: var(--color-text-secondary, #555);
		line-height: 1.5;
	}

	.link-btn {
		background: none;
		border: none;
		padding: 0;
		color: var(--color-primary);
		text-decoration: underline;
		cursor: pointer;
		font: inherit;
	}

	kbd {
		display: inline-block;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.8em;
		padding: 1px 6px;
		border: 1px solid var(--color-border, #ccc);
		border-bottom-width: 2px;
		border-radius: 4px;
		background: var(--color-bg-secondary, #f7f7f7);
		color: var(--color-text);
		line-height: 1.4;
		min-width: 1.6em;
		text-align: center;
	}

	.hint {
		font-size: 0.88rem;
		color: var(--color-text-secondary, #888);
		margin-bottom: 12px;
	}

	.share-list {
		list-style: none;
		padding: 0;
		margin: 8px 0;
	}

	.share-row {
		padding: 8px 0;
		border-bottom: 1px solid var(--color-border, #eee);
	}

	.share-row label {
		display: flex;
		align-items: center;
		gap: 10px;
		cursor: pointer;
	}

	.share-name {
		flex: 1;
	}

	.share-count {
		color: var(--color-text-secondary, #888);
		font-size: 0.85rem;
	}

	.share-progress {
		margin-top: 12px;
	}

	.share-progress progress {
		width: 100%;
	}

	/* ── 이미지 캐시 ─────────────────────────────────────────────────────── */

	.image-cache-quota-row {
		align-items: center;
		margin-bottom: 12px;
	}

	.image-cache-quota-label {
		flex-shrink: 0;
		font-size: clamp(0.85rem, 2.5vw, 0.95rem);
		color: var(--color-text-secondary);
	}

	.image-cache-quota-input {
		max-width: 120px;
		flex: 0 0 auto;
	}
</style>
