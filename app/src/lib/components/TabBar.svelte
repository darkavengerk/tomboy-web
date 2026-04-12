<script lang="ts">
	interface Props {
		currentPath: string;
	}

	let { currentPath }: Props = $props();

	const items = [
		{ href: '/', label: '홈', icon: '🏠' },
		{ href: '/notes', label: '전체', icon: '📄' },
		{ href: '/notebooks', label: '노트북', icon: '🗂' },
		{ href: '/random', label: '랜덤', icon: '🎲' }
	];

	function isActive(href: string): boolean {
		if (href === '/') return currentPath === '/';
		return currentPath === href || currentPath.startsWith(href + '/');
	}
</script>

<nav class="tab-bar" aria-label="주요 탐색">
	{#each items as item (item.href)}
		<a
			href={item.href}
			class="tab-item"
			class:active={isActive(item.href)}
			aria-current={isActive(item.href) ? 'page' : undefined}
		>
			<span class="tab-icon">{item.icon}</span>
			<span class="tab-label">{item.label}</span>
		</a>
	{/each}
</nav>

<style>
	.tab-bar {
		display: flex;
		background: var(--color-bg, #fff);
		border-top: 1px solid var(--color-border, #eee);
		padding-bottom: var(--safe-area-bottom, 0px);
		flex-shrink: 0;
	}

	.tab-item {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 8px 4px;
		text-decoration: none;
		color: var(--color-text-secondary, #888);
		gap: 2px;
		min-height: 52px;
	}

	.tab-item.active {
		color: var(--color-primary, #1a73e8);
	}

	.tab-icon {
		font-size: 1.3rem;
		line-height: 1;
	}

	.tab-label {
		font-size: 0.7rem;
		font-weight: 500;
	}
</style>
