<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import Toast from '$lib/components/Toast.svelte';
	import TopNav from '$lib/components/TopNav.svelte';
	import { page } from '$app/state';
	import { createHistoryTracker } from '$lib/nav/history.js';
	import { appMode, modeFromUrl } from '$lib/stores/appMode.svelte.js';
	import { maybeRedirectToDesktop } from '$lib/desktop/viewportRedirect.js';

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
		maybeRedirectToDesktop(page.url.pathname);

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

		return () => {
			window.removeEventListener('offline', goOffline);
			window.removeEventListener('online', goOnline);
			window.removeEventListener('beforeinstallprompt', onInstallPrompt);
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
{/if}

<style>
	.app-shell {
		height: 100vh;
		height: 100dvh;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	/* When embedded (in an iframe) or on the desktop route, the settings page
	   still needs a flex column container so its inner layout (which uses
	   height:100%) sizes correctly. */
	.chromeless {
		height: 100vh;
		height: 100dvh;
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
