<script lang="ts">
  import { onMount } from 'svelte';
  import { hueCall, getHueContext, HueError } from '$lib/hue/hueClient.js';
  import type { HueLight } from '$lib/hue/hueTypes.js';
  import { planLightImports } from '$lib/hue/hueImport.js';
  import { firstBodyLineOf } from '$lib/hue/noteBody.js';
  import { createNote, ensureUniqueTitle, listNotesShared } from '$lib/core/noteManager.js';
  import { pushToast } from '$lib/stores/toast.js';

  let paired = $state(false);
  let busy = $state(false);

  onMount(async () => { paired = (await getHueContext()) !== null; });

  async function existingLightIds(): Promise<Set<string>> {
    const notes = await listNotesShared();
    const ids = new Set<string>();
    for (const n of notes) { const m = /^light:([0-9a-fA-F-]{36})$/.exec(firstBodyLineOf(n.xmlContent).trim()); if (m) ids.add(m[1]); }
    return ids;
  }

  async function importLights() {
    busy = true;
    try {
      const data = (await hueCall('GET', 'light')) as { data?: HueLight[] };
      const lights = data.data ?? [];
      const existing = await existingLightIds();
      const plan = planLightImports(lights, existing);
      for (const item of plan) {
        const title = await ensureUniqueTitle(item.title);
        await createNote({ title, bodyFirstLine: item.bodyFirstLine });
      }
      pushToast(plan.length ? `전구 ${plan.length}개 노트 생성` : '새 전구 없음');
    } catch (e) {
      pushToast(e instanceof HueError && e.kind === 'no_bridge' ? '설정에서 Hue를 먼저 연결' : '조명 브릿지에 연결 안 됨');
    } finally { busy = false; }
  }

  async function allOnOff(on: boolean) {
    busy = true;
    try {
      const data = (await hueCall('GET', 'light')) as { data?: HueLight[] };
      for (const l of data.data ?? []) { await hueCall('PUT', `light/${l.id}`, { on: { on } }); }
      pushToast(on ? '전체 켜짐' : '전체 꺼짐');
    } catch { pushToast('전체 제어 실패'); } finally { busy = false; }
  }
</script>

<div class="master-dashboard">
  {#if !paired}
    <span class="hue-status hue-error">설정 → Hue 에서 허브를 먼저 연결하세요.</span>
  {:else}
    <div class="master-row">
      <button type="button" disabled={busy} onclick={importLights}>전구 가져오기</button>
      <button type="button" disabled={busy} onclick={() => allOnOff(true)}>전체 켜기</button>
      <button type="button" disabled={busy} onclick={() => allOnOff(false)}>전체 끄기</button>
    </div>
  {/if}
</div>

<style>
  .master-dashboard { padding: 0.6rem; border: 1px solid var(--border, #ddd); border-radius: 8px; margin: 0.3rem 0; }
  .master-row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
  .master-row button { padding: 0.3rem 0.8rem; border-radius: 8px; border: 1px solid var(--border, #ccc); }
  .hue-status { font-size: 0.85rem; } .hue-error { color: #c0392b; }
</style>
