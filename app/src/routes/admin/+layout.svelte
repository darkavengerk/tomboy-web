<script lang="ts">
	import { page } from '$app/state';

	let { children } = $props();

	const tabs = [
		{ href: '/admin', label: '대시보드', exact: true },
		{ href: '/admin/revisions', label: '리비전' },
		{ href: '/admin/browse', label: '파일 탐색' },
		{ href: '/admin/sleepnote', label: '슬립노트' },
		{ href: '/admin/gpu', label: 'GPU' },
		{ href: '/admin/tools', label: '도구' }
	];

	function isActive(href: string, exact: boolean | undefined): boolean {
		const p = page.url.pathname;
		if (exact) return p === href;
		return p === href || p.startsWith(href + '/');
	}
</script>

<div class="admin">
	<header class="admin-header">
		<div class="admin-title">
			<a href="/settings" class="back-link">← 설정</a>
			<h1>Dropbox 관리자</h1>
		</div>
		<nav class="admin-tabs">
			{#each tabs as t}
				<a
					href={t.href}
					class="tab"
					class:active={isActive(t.href, t.exact)}
				>
					{t.label}
				</a>
			{/each}
		</nav>
	</header>
	<main class="admin-body">
		{@render children()}
	</main>
</div>

<style>
	.admin {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
	}
	.admin-header {
		border-bottom: 1px solid var(--color-border, #e5e7eb);
		padding: 12px 24px 0;
		background: var(--color-bg-secondary, #f7f7f8);
	}
	.admin-title {
		display: flex;
		align-items: baseline;
		gap: 16px;
		margin-bottom: 8px;
	}
	.admin-title h1 {
		margin: 0;
		font-size: 1.15rem;
		font-weight: 600;
	}
	.back-link {
		font-size: 0.85rem;
		color: var(--color-text-secondary, #6b7280);
		text-decoration: none;
	}
	.back-link:hover { text-decoration: underline; }

	.admin-tabs {
		display: flex;
		gap: 4px;
	}
	.tab {
		padding: 8px 14px;
		text-decoration: none;
		color: var(--color-text-secondary, #6b7280);
		font-size: 0.9rem;
		border-bottom: 2px solid transparent;
		transition: color 0.1s;
	}
	.tab:hover { color: var(--color-text, #111); }
	.tab.active {
		color: var(--color-primary, #2563eb);
		border-bottom-color: var(--color-primary, #2563eb);
		font-weight: 600;
	}

	.admin-body {
		flex: 1;
		overflow-y: auto;
		padding: 24px;
	}
</style>
