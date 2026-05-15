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
		TERMINAL_HISTORY_BLOCKLIST_DEFAULT
	} from '$lib/storage/appSettings.js';
	import { listNotebooks, getNotebook } from '$lib/core/notebooks.js';
	import { getAllNotes } from '$lib/storage/noteStore.js';
	import { setNotebookPublic } from '$lib/sync/firebase/publishNotebook.js';
	import { readPublicConfigForHost } from '$lib/sync/firebase/publicConfig.js';
	import { ensureSignedIn } from '$lib/firebase/app.js';

	type Tab = 'sync' | 'config' | 'share' | 'terminal' | 'notify' | 'guide' | 'shortcuts' | 'advanced';
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

	// ── 원격 브릿지 ───────────────────────────────────────────────────
	let terminalBridgeUrl = $state('');
	let terminalBridgeSaved = $state(false);
	let terminalBridgePassword = $state('');
	let terminalBridgeAuthed = $state<boolean | null>(null); // null = unknown
	let terminalBridgeBusy = $state(false);
	let terminalBridgeMessage = $state('');

	// ── 터미널 히스토리 설정 ──────────────────────────────────────────
	let termHistOpenDesktop = $state(true);
	let termHistOpenMobile = $state(false);
	let termHistBlocklistText = $state('');
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
	}

	async function saveTermHistOpenDesktop(): Promise<void> {
		await setTerminalHistoryPanelOpenDesktop(termHistOpenDesktop);
	}
	async function saveTermHistOpenMobile(): Promise<void> {
		await setTerminalHistoryPanelOpenMobile(termHistOpenMobile);
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
					처음 쓸 때 한 번씩 훑어보세요.
				</p>
			</section>

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
			</section>

			<section class="section">
				<h2>환경 / 호환성 요구사항</h2>
				<p class="info-text">이게 안 맞으면 해당 기능이 동작하지 않거나 깨져 보입니다.</p>

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
						<tr><td><kbd>Ctrl</kbd>+<kbd>O</kbd></td><td>TODO 블록 삽입</td></tr>
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
						<tr><td><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>←</kbd> / <kbd>→</kbd> / <kbd>↑</kbd> / <kbd>↓</kbd></td><td>인접 워크스페이스로 전환</td></tr>
						<tr><td><kbd>Esc</kbd></td><td>활성 윈도우/모달 닫기</td></tr>
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
</style>
