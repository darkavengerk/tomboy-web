<script lang="ts">
	let {
		localTitle,
		remoteTitle,
		remoteDeviceName,
		onpick,
		oncancel
	}: {
		localTitle: string;
		remoteTitle: string;
		remoteDeviceName: string;
		onpick: (which: 'local' | 'remote') => void;
		oncancel: () => void;
	} = $props();
</script>

<div class="picker" role="dialog" aria-label="재생 위치 선택">
	<button type="button" class="opt" onclick={() => onpick('local')}>
		<span class="lbl">이 기기에서 듣던 곡</span>
		<span class="trk">{localTitle}</span>
	</button>
	<button type="button" class="opt" onclick={() => onpick('remote')}>
		<span class="lbl">{remoteDeviceName}에서 듣던 곡</span>
		<span class="trk">{remoteTitle}</span>
	</button>
	<button type="button" class="cancel" onclick={oncancel}>취소</button>
</div>

<style>
	.picker {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px;
	}
	.opt {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		padding: 12px 14px;
		border: 1px solid var(--color-border, #333);
		border-radius: 10px;
		background: var(--color-bg, #111);
		color: var(--color-text, #eee);
		cursor: pointer;
		text-align: left;
	}
	.opt .lbl { font-size: 0.78rem; opacity: 0.7; }
	.opt .trk { font-size: 0.95rem; font-weight: 600; }
	.cancel {
		align-self: center;
		background: none;
		border: none;
		color: var(--color-text-secondary, #999);
		cursor: pointer;
		padding: 6px;
	}
</style>
