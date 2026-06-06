<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { afterNavigate, goto } from '$app/navigation';
	import { browser } from '$app/environment';
	import Toast from '$lib/components/Toast.svelte';
	import ImageViewerModal from '$lib/components/ImageViewerModal.svelte';
	import TopNav from '$lib/components/TopNav.svelte';
	import { page, updated } from '$app/state';
	import { createHistoryTracker } from '$lib/nav/history.js';
	import { appMode, modeFromUrl } from '$lib/stores/appMode.svelte.js';
	import { mode } from '$lib/stores/guestMode.svelte.js';
	import { bindViewportHeight } from '$lib/viewport/viewportHeight.js';
	import {
		installOnlineFlushListener,
		flushIfEnabled
	} from '$lib/schedule/flushScheduler.js';
	import { subscribeForegroundMessages } from '$lib/schedule/notification.js';
	import { installRealNoteSync } from '$lib/sync/firebase/install.js';
	import { installBacklinkIndex } from '$lib/core/backlinkIndex.js';
	import { installImageFetchers } from '$lib/imageCache/fetchers/install.js';
	import { installMusicAudio } from '$lib/music/musicAudio.svelte.js';
	import { pushToast } from '$lib/stores/toast.js';
	import { getAllNotes } from '$lib/storage/noteStore.js';
	import { favoriteStore } from '$lib/storage/favoriteStore.svelte.js';
	import { getCachedPublicConfig, discoverPublicConfigForGuest } from '$lib/sync/firebase/publicConfig.js';

	let { children } = $props();

	const isDesktopRoute = $derived(page.url.pathname.startsWith('/desktop'));
	const isEmbedded = $derived(page.url.searchParams.get('embed') === '1');
	// Desktop SettingsWindow/AdminWindow load app routes inside an <iframe>.
	// `embed=1` is the explicit chromeless signal, but it's lost on internal
	// client-side navigations (e.g. clicking the admin tabs jumps to
	// `/admin/revisions` with no query), so detect *being framed* as well —
	// it stays true for the whole iframe lifetime regardless of navigation.
	const inIframe = browser && isFramed();
	const isChromeless = $derived(
		isDesktopRoute ||
		isEmbedded ||
		inIframe ||
		page.url.pathname.startsWith('/welcome')
	);

	function isFramed(): boolean {
		try {
			return window.self !== window.top;
		} catch {
			// Cross-origin access to window.top throws — we're definitely framed.
			return true;
		}
	}

	let offline = $state(false);
	let installPrompt: BeforeInstallPromptEvent | null = $state(null);
	let showInstallBanner = $state(false);
	let canGoBack = $state(false);
	let canGoForward = $state(false);

	interface BeforeInstallPromptEvent extends Event {
		prompt(): Promise<void>;
		userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
	}

	const tracker = createHistoryTracker();

	afterNavigate(({ type }) => {
		tracker.onNavigate(type);
		canGoBack = tracker.canGoBack();
		canGoForward = tracker.canGoForward();
		const derived = modeFromUrl(page.url.pathname, page.url.searchParams);
		if (derived) appMode.set(derived);
		const isOauthCallback =
			page.url.pathname === '/settings' && page.url.searchParams.has('code');
		if (mode.value === 'visitor'
				&& !page.url.pathname.startsWith('/welcome')
				&& !isOauthCallback) {
			void goto('/welcome', { replaceState: true });
			return;
		}
		if (mode.value === 'guest') {
			const path = page.url.pathname;
			const blocked =
				path.startsWith('/settings') ||
				path.startsWith('/admin') ||
				path.startsWith('/desktop') ||
				path === '/sleepnote';
			if (blocked) {
				void goto('/notes', { replaceState: true });
				return;
			}
			if (path === '/') {
				void redirectGuestHome();
			}
		}
	});

	async function redirectGuestHome() {
		let cfg = getCachedPublicConfig();
		if (!cfg) {
			try {
				cfg = await discoverPublicConfigForGuest();
			} catch {
				cfg = null;
			}
		}
		const shared = cfg?.sharedNotebooks ?? [];
		if (shared.length === 0) {
			void goto('/notes', { replaceState: true });
			return;
		}
		const all = await getAllNotes();
		const first = shared[0];
		const cand = all
			.filter((n) => !n.deleted && n.tags.includes(`system:notebook:${first}`))
			.sort((a, b) => b.changeDate.localeCompare(a.changeDate))[0];
		if (cand) {
			void goto(`/note/${cand.guid}`, { replaceState: true });
		} else {
			void goto('/notes', { replaceState: true });
		}
	}

	function handleBack() {
		tracker.goBack();
		canGoBack = tracker.canGoBack();
		canGoForward = tracker.canGoForward();
		history.back();
	}

	function handleForward() {
		tracker.goForward();
		canGoBack = tracker.canGoBack();
		canGoForward = tracker.canGoForward();
		history.forward();
	}

	onMount(() => {
		offline = !navigator.onLine;
		const goOffline = () => { offline = true; };
		const goOnline = () => { offline = false; };
		window.addEventListener('offline', goOffline);
		window.addEventListener('online', goOnline);

		// 배포 직후 새로고침 화이트스크린 복구.
		// 새 빌드가 올라가면 옛 HTML 셸이 참조하던 해시 청크가 Vercel 에서
		// 사라진다. 그 청크를 lazy-import 하다 실패하면 Vite 가
		// `vite:preloadError` 를 쏜다 — 이때 한 번만 새로고침해 새 빌드의
		// 청크를 받아오게 한다. (이 onMount 가 돌았다는 건 셸이 정상 부팅됐다는
		// 뜻이므로 가드를 풀어, 다음 배포 때 다시 1회 리로드가 허용되게 한다.
		// 셸 자체가 깨지면 onMount 가 안 돌아 가드가 남으므로 무한 새로고침 방지.)
		const PRELOAD_RELOAD_KEY = 'tomboy:preload-reload';
		sessionStorage.removeItem(PRELOAD_RELOAD_KEY);
		const onPreloadError = (e: Event) => {
			e.preventDefault();
			if (sessionStorage.getItem(PRELOAD_RELOAD_KEY)) return;
			sessionStorage.setItem(PRELOAD_RELOAD_KEY, '1');
			location.reload();
		};
		window.addEventListener('vite:preloadError', onPreloadError);

		const onInstallPrompt = (e: Event) => {
			e.preventDefault();
			installPrompt = e as BeforeInstallPromptEvent;
			if (!window.matchMedia('(display-mode: standalone)').matches) {
				showInstallBanner = true;
			}
		};
		window.addEventListener('beforeinstallprompt', onInstallPrompt);

		const unbindViewport = bindViewportHeight();

		// 즐겨찾기 — 로컬 전용 set 을 appSettings 에서 복원.
		void favoriteStore.load();

		// 이미지 캐시 fetcher 등록 — Dropbox SDK 우회로 등이 lookupOrFetch
		// 미스 경로에서 활성화됨. idempotent.
		installImageFetchers();

		// 백링크 인덱스 빌드 — IDB read만 하므로 auth 와 무관. 가능한 한 빨리
		// 시작해서 첫 번째 rename sweep 전까지 따뜻하게 유지.
		installBacklinkIndex();

		// 전역 음악 오디오 엔진 — 단일 <audio> 를 musicPlayer 로 구동. 음악 노트
		// 패널은 순수 뷰라 여러 창이 떠도 소리는 하나. idempotent 싱글톤.
		const uninstallMusicAudio = installMusicAudio();

		// 일정 알림: 온라인 복귀 시 미발신 diff 자동 flush + 시작 시 한 번 시도.
		installOnlineFlushListener();
		void flushIfEnabled();

		// 방문자/게스트/호스트 모드 감지 — note sync 보다 먼저 실행.
		// async 이므로 void 로 실행; 완료 후 installRealNoteSync 연쇄.
		// mode 의 초기값은 guestMode.svelte.ts 의 detectInitialMode 가 localStorage 에서
		// 동기로 세팅함. 여기서는 토큰 refresh 실패로 진짜 'visitor' 로 latch 되는 경우를
		// 잡아 사용자에게 알려준다 (race-resolved-bad: 토큰은 있었지만 refresh 가 실패).
		const initialMode = mode.value;
		void mode.detectAndSet().then((finalMode) => {
			if (initialMode === 'host' && finalMode === 'visitor') {
				pushToast('Dropbox 연결이 끊겼습니다. 다시 로그인해주세요.', { kind: 'error' });
				void goto('/welcome', { replaceState: true });
			}
			// 파이어베이스 노트 실시간 동기화: 저장된 토글 값을 읽어 활성화 상태로 복원.
			// 토글이 OFF면 push/subscribe 모두 no-op 으로 비용 없음.
			void installRealNoteSync();
		});

		// 포그라운드 푸시 구독 — 사용자가 같은 세션에서 알림을 활성화한 직후 테스트
		// 시 구독이 누락되지 않도록 무조건 호출. Firebase 미지원/미초기화면 no-op 반환.
		// 핸들러는 시스템 알림 띄움(notification.ts) + 토스트 둘 다 표시.
		let unsubFcm: (() => void) | undefined;
		void (async () => {
			unsubFcm = await subscribeForegroundMessages(({ title, body }) => {
				pushToast(`${title ?? '알림'} — ${body ?? ''}`, { kind: 'info' });
			});
		})();

		// Alt 키 단독 입력 시 브라우저 메뉴바가 포커스되는 동작을 전역에서 억제.
		// Alt+키 조합은 각각 별도 keydown을 받으므로 영향 없음.
		const swallowAlt = (e: KeyboardEvent) => {
			if (e.key === 'Alt' && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
				e.preventDefault();
			}
		};
		window.addEventListener('keydown', swallowAlt);
		window.addEventListener('keyup', swallowAlt);

		return () => {
			window.removeEventListener('offline', goOffline);
			window.removeEventListener('online', goOnline);
			window.removeEventListener('vite:preloadError', onPreloadError);
			window.removeEventListener('beforeinstallprompt', onInstallPrompt);
			window.removeEventListener('keydown', swallowAlt);
			window.removeEventListener('keyup', swallowAlt);
			unbindViewport();
			unsubFcm?.();
			uninstallMusicAudio();
		};
	});

	// 새 배포 감지 안내 — version.pollInterval(svelte.config.js) 이 새 버전을
	// 발견하면 updated.current 가 true 로 latch 된다. SvelteKit 은 이때부터
	// 다음 내비게이션을 자동으로 풀 페이지 로드로 처리하지만(=새 청크 수신),
	// 사용자가 그 사이 화이트스크린을 만나지 않도록 한 번만 토스트로 알린다.
	let notifiedUpdate = false;
	$effect(() => {
		if (updated.current && !notifiedUpdate) {
			notifiedUpdate = true;
			pushToast('새 버전이 배포되었습니다. 새로고침하면 적용됩니다.', {
				kind: 'info',
				timeoutMs: 8000
			});
		}
	});

	async function handleInstall() {
		if (!installPrompt) return;
		await installPrompt.prompt();
		const { outcome } = await installPrompt.userChoice;
		if (outcome === 'accepted') {
			showInstallBanner = false;
		}
		installPrompt = null;
	}

	function dismissInstallBanner() {
		showInstallBanner = false;
	}
</script>

<svelte:head>
	<title>Tomboy Web</title>
</svelte:head>

{#if isChromeless}
	<div class="chromeless">
		{@render children()}
	</div>
	<Toast />
	<ImageViewerModal />
{:else}
	{#if offline}
		<div class="offline-banner" role="alert">
			오프라인 상태입니다
		</div>
	{/if}

	{#if showInstallBanner}
		<div class="install-banner">
			<span>홈 화면에 추가하여 앱처럼 사용하세요</span>
			<div class="install-actions">
				<button class="install-btn" onclick={handleInstall}>설치</button>
				<button class="dismiss-btn" onclick={dismissInstallBanner}>✕</button>
			</div>
		</div>
	{/if}

	<div class="app-shell">
		<TopNav
			{canGoBack}
			{canGoForward}
			onback={handleBack}
			onforward={handleForward}
		/>
		<div class="content">
			{@render children()}
		</div>
	</div>
	<Toast />
	<ImageViewerModal />
{/if}

<style>
	.app-shell {
		/* 모바일 route 는 body 가 scrollable. shell 은 일반 flex column,
		   viewport 를 최소로 채우게 min-height. TopNav 는 sticky top,
		   하단 toolbar 는 fixed bottom (키보드 inset 적용). 키보드가
		   뜨면 OS 가 body 를 scroll 해서 cursor 를 visible 영역으로
		   올려줌 — 우리가 vv panning 을 추적할 필요 없음. */
		display: flex;
		flex-direction: column;
		min-height: 100dvh;
	}

	/* desktop route (multi-window) 와 embedded 모드는 페이지 scroll 이
	   의미 없으므로 fixed 유지. 키보드 inset 만 적용. */
	.chromeless {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: var(--keyboard-inset, 0px);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.chromeless > :global(*) {
		flex: 1;
		min-height: 0;
	}

	.content {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	.offline-banner {
		background: var(--color-text-secondary);
		color: white;
		text-align: center;
		padding: 4px 12px;
		font-size: 0.8rem;
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		z-index: 1000;
	}

	.install-banner {
		background: var(--color-primary);
		color: white;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 12px;
		font-size: 0.85rem;
		position: fixed;
		bottom: 0;
		left: 0;
		right: 0;
		z-index: 1000;
		padding-bottom: calc(8px + var(--safe-area-bottom));
	}

	.install-actions {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-shrink: 0;
	}

	.install-btn {
		background: white;
		color: var(--color-primary);
		border: none;
		border-radius: 4px;
		padding: 4px 12px;
		font-weight: 600;
		font-size: 0.85rem;
	}

	.dismiss-btn {
		background: none;
		border: none;
		color: white;
		font-size: 1rem;
		padding: 4px;
		opacity: 0.8;
	}
</style>
