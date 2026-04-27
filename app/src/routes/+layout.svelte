<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import Toast from '$lib/components/Toast.svelte';
	import ImageViewerModal from '$lib/components/ImageViewerModal.svelte';
	import TopNav from '$lib/components/TopNav.svelte';
	import { page } from '$app/state';
	import { createHistoryTracker } from '$lib/nav/history.js';
	import { appMode, modeFromUrl } from '$lib/stores/appMode.svelte.js';
	import { bindViewportHeight } from '$lib/viewport/viewportHeight.js';
	import {
		installOnlineFlushListener,
		flushIfEnabled
	} from '$lib/schedule/flushScheduler.js';
	import { subscribeForegroundMessages } from '$lib/schedule/notification.js';
	import { installRealNoteSync } from '$lib/sync/firebase/install.js';
	import { pushToast } from '$lib/stores/toast.js';

	let { children } = $props();

	const isDesktopRoute = $derived(page.url.pathname.startsWith('/desktop'));
	const isEmbedded = $derived(page.url.searchParams.get('embed') === '1');
	const isChromeless = $derived(isDesktopRoute || isEmbedded);

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
	});

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

		const onInstallPrompt = (e: Event) => {
			e.preventDefault();
			installPrompt = e as BeforeInstallPromptEvent;
			if (!window.matchMedia('(display-mode: standalone)').matches) {
				showInstallBanner = true;
			}
		};
		window.addEventListener('beforeinstallprompt', onInstallPrompt);

		const unbindViewport = bindViewportHeight();

		// 일정 알림: 온라인 복귀 시 미발신 diff 자동 flush + 시작 시 한 번 시도.
		installOnlineFlushListener();
		void flushIfEnabled();

		// 파이어베이스 노트 실시간 동기화: 저장된 토글 값을 읽어 활성화 상태로 복원.
		// 토글이 OFF면 push/subscribe 모두 no-op 으로 비용 없음.
		void installRealNoteSync();

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
			window.removeEventListener('beforeinstallprompt', onInstallPrompt);
			window.removeEventListener('keydown', swallowAlt);
			window.removeEventListener('keyup', swallowAlt);
			unbindViewport();
			unsubFcm?.();
		};
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
		/* Fill the dynamic viewport; when the on-screen keyboard is open,
		   `--keyboard-inset` (set by bindViewportHeight) shrinks the
		   content area from the bottom so the toolbar lands right above
		   the keyboard. See lib/viewport/viewportHeight.ts for the
		   rationale — pinning to `visualViewport.height` instead caused
		   blank space when the Safari URL bar was visible and visibly
		   fought iOS's scroll-to-focus. */
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		height: 100vh;
		height: 100dvh;
		padding-bottom: var(--keyboard-inset, 0px);
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	/* When embedded (in an iframe) or on the desktop route, the settings page
	   still needs a flex column container so its inner layout (which uses
	   height:100%) sizes correctly. */
	.chromeless {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		height: 100vh;
		height: 100dvh;
		padding-bottom: var(--keyboard-inset, 0px);
		box-sizing: border-box;
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
		overflow: hidden;
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
