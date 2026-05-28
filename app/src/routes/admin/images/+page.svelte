<script lang="ts">
  import { onMount } from 'svelte';
  import {
    loadImageInventory,
    type ImageInventoryItem,
    type ImageInventory
  } from '$lib/sync/imageInventory.js';
  import { promoteImageToDropbox } from '$lib/sync/imagePromotion.js';
  import { deleteTempImage } from '$lib/sync/tempImageUpload.js';
  import { lookupOrFetch } from '$lib/imageCache/imageCache.js';
  import { pushToast, dismissToast } from '$lib/stores/toast.js';

  let inventory = $state<ImageInventory | null>(null);
  let loading = $state(false);
  let busyUrl = $state<string | null>(null);

  // url → resolved src (ObjectURL on cache hit/successful fetch, else original
  // URL fallback). Dropbox URLs need this because plain `<img src>` can fail
  // on some referrer/redirect combinations; lookupOrFetch routes through the
  // Dropbox SDK fetcher (CORS-safe) like the editor's imagePreviewPlugin.
  let thumbs = $state<Record<string, string>>({});

  async function resolveThumb(url: string): Promise<void> {
    if (thumbs[url]) return;
    try {
      const { src } = await lookupOrFetch(url);
      thumbs[url] = src;
    } catch {
      thumbs[url] = url;
    }
  }

  $effect(() => {
    for (const item of inventory?.items ?? []) {
      void resolveThumb(item.url);
    }
  });

  async function refresh() {
    loading = true;
    try {
      inventory = await loadImageInventory();
    } catch (err) {
      pushToast(`인벤토리 로드 실패: ${(err as Error).message}`, { kind: 'error' });
    } finally {
      loading = false;
    }
  }

  onMount(refresh);

  async function promote(item: ImageInventoryItem) {
    if (busyUrl) return;
    busyUrl = item.url;
    const toastId = pushToast('Dropbox로 저장 중…', { timeoutMs: 0 });
    try {
      const result = await promoteImageToDropbox(item.url);
      dismissToast(toastId);
      if (result.partialFailure) {
        pushToast(
          `일부 노트 갱신 실패 (${result.failed.length}개). admin에서 다시 시도 가능.`,
          { kind: 'error' }
        );
      } else if (result.vercelDeleteError) {
        pushToast(
          'Dropbox 저장 완료. 임시 이미지 정리 실패 — 새로고침 후 다시 시도.',
          { kind: 'error' }
        );
      } else {
        pushToast('Dropbox로 저장 완료');
      }
    } catch (err) {
      dismissToast(toastId);
      pushToast(`승격 실패: ${(err as Error).message}`, { kind: 'error' });
    } finally {
      busyUrl = null;
      await refresh();
    }
  }

  async function removeBlob(item: ImageInventoryItem) {
    if (busyUrl) return;
    if (item.usedIn.length > 0) {
      const ok = window.confirm(
        `이 이미지는 ${item.usedIn.length}개 노트에서 사용 중입니다. 삭제하면 노트의 이미지가 깨집니다. 진행할까요?`
      );
      if (!ok) return;
    }
    busyUrl = item.url;
    try {
      await deleteTempImage(item.url);
      pushToast('임시 이미지 삭제 완료');
    } catch (err) {
      pushToast(`삭제 실패: ${(err as Error).message}`, { kind: 'error' });
    } finally {
      busyUrl = null;
      await refresh();
    }
  }

  function badgeLabel(storage: ImageInventoryItem['storage']): string {
    if (storage === 'temp') return '임시';
    if (storage === 'dropbox') return '저장됨';
    return '외부';
  }
</script>

<section class="page">
  <header>
    <h2>이미지 인벤토리</h2>
    <button onclick={refresh} disabled={loading}>
      {loading ? '로딩 중…' : '새로고침'}
    </button>
  </header>

  {#if inventory?.listError}
    <div class="banner warn">
      ⚠️ 오펀 임시 이미지 목록을 가져오지 못했습니다 ({inventory.listError}).
      노트에서 참조 중인 이미지만 표시됩니다.
    </div>
  {/if}

  {#if inventory && inventory.items.length === 0}
    <p class="empty">표시할 이미지가 없습니다.</p>
  {/if}

  <div class="grid">
    {#each inventory?.items ?? [] as item (item.url)}
      <article class="card" class:busy={busyUrl === item.url}>
        <div class="thumb">
          <!-- decorative thumbnail; src resolved via image cache (Dropbox SDK route etc.) -->
          <img src={thumbs[item.url] ?? item.url} alt="" loading="lazy" />
        </div>
        <div class="meta">
          <div class="badges">
            <span class="badge badge-{item.storage}">{badgeLabel(item.storage)}</span>
            {#if item.isOrphan}
              <span class="badge badge-orphan">오펀</span>
            {/if}
          </div>
          {#if item.size !== undefined}
            <div class="size">{Math.round(item.size / 1024)} KB</div>
          {/if}
          <div class="used-in">
            {#if item.usedIn.length === 0}
              <em>참조 없음</em>
            {:else}
              {#each item.usedIn as ref}
                <a href="/note/{ref.guid}" target="_blank" rel="noopener noreferrer">{ref.title || ref.guid.slice(0, 8)}</a>
              {/each}
            {/if}
          </div>
          {#if item.storage === 'temp'}
            <div class="actions">
              <button
                onclick={() => promote(item)}
                disabled={busyUrl !== null}
              >
                Dropbox로 저장
              </button>
              <button
                class="danger"
                onclick={() => removeBlob(item)}
                disabled={busyUrl !== null}
              >
                삭제
              </button>
            </div>
          {/if}
        </div>
      </article>
    {/each}
  </div>
</section>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  header h2 {
    margin: 0;
    font-size: 1.05rem;
  }
  .banner.warn {
    padding: 10px 14px;
    background: #fff7e0;
    border: 1px solid #f0c674;
    border-radius: 6px;
    font-size: 0.85rem;
  }
  .empty {
    color: #6b7280;
    font-size: 0.9rem;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 12px;
  }
  .card {
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    background: #fff;
  }
  .card.busy {
    opacity: 0.6;
  }
  .thumb {
    aspect-ratio: 1 / 1;
    background: #f3f4f6;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .thumb img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .meta {
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 0.8rem;
  }
  .badges {
    display: flex;
    gap: 4px;
  }
  .badge {
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 0.7rem;
    font-weight: 600;
  }
  .badge-temp {
    background: #fef3c7;
    color: #92400e;
  }
  .badge-dropbox {
    background: #dbeafe;
    color: #1e40af;
  }
  .badge-external {
    background: #e5e7eb;
    color: #374151;
  }
  .badge-orphan {
    background: #fecaca;
    color: #991b1b;
  }
  .size {
    color: #6b7280;
  }
  .used-in {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .used-in a {
    color: #2563eb;
    text-decoration: none;
  }
  .used-in a:hover {
    text-decoration: underline;
  }
  .actions {
    display: flex;
    gap: 6px;
    margin-top: auto;
  }
  .actions button {
    flex: 1;
    padding: 6px 8px;
    font-size: 0.75rem;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    background: #fff;
    cursor: pointer;
  }
  .actions button:hover:not(:disabled) {
    background: #f9fafb;
  }
  .actions button.danger {
    color: #dc2626;
    border-color: #fca5a5;
  }
  .actions button:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
</style>
