<script lang="ts">
  import { onMount } from 'svelte';
  import type { EditorView } from '@tiptap/pm/view';
  import { hueCall, HueError } from '$lib/hue/hueClient.js';
  import type { HueZone, HueScene } from '$lib/hue/hueTypes.js';
  import { groupedLightIdOf, resolveMembershipIds, toChildrenRefs } from '$lib/hue/zoneOps.js';
  import { extractMembershipTitles } from '$lib/hue/hueNoteParse.js';
  import { listNotesShared } from '$lib/core/noteManager.js';
  import { pushToast } from '$lib/stores/toast.js';
  import { firstBodyLineOf } from '$lib/hue/noteBody.js';

  let { zoneId, view }: { zoneId: string | null; view: EditorView; getGuid?: () => string; oninternallink?: (t: string) => void } = $props();

  let zone = $state<HueZone | null>(null);
  let groupedOn = $state(false);
  let brightness = $state(100);
  let scenes = $state<HueScene[]>([]);
  let status = $state('');
  let glId = $state<string | null>(null);

  async function load() {
    if (!zoneId) { status = 'Hue에 아직 미생성 — [Hue에 반영]'; return; }
    status = '불러오는 중…';
    try {
      const zd = (await hueCall('GET', `zone/${zoneId}`)) as { data?: HueZone[] };
      zone = zd.data?.[0] ?? null;
      if (zone) {
        glId = groupedLightIdOf(zone);
        if (glId) {
          const gd = (await hueCall('GET', `grouped_light/${glId}`)) as { data?: Array<{ on: { on: boolean }; dimming?: { brightness: number } }> };
          const g = gd.data?.[0];
          groupedOn = g?.on.on ?? false; brightness = g?.dimming?.brightness ?? 100;
        }
        const sd = (await hueCall('GET', 'scene')) as { data?: HueScene[] };
        scenes = (sd.data ?? []).filter((s) => s.group?.rid === zoneId);
      }
      status = '';
    } catch (e) { status = e instanceof HueError && e.kind === 'no_bridge' ? '설정에서 Hue를 먼저 연결' : '조명 브릿지에 연결 안 됨'; }
  }
  onMount(load);

  async function setGroupOn(on: boolean) {
    if (!glId) return; const prev = groupedOn; groupedOn = on;
    try { await hueCall('PUT', `grouped_light/${glId}`, { on: { on } }); } catch { groupedOn = prev; pushToast('그룹 제어 실패'); }
  }
  async function setGroupBrightness(v: number) {
    if (!glId) return; const prev = brightness; brightness = v;
    try { await hueCall('PUT', `grouped_light/${glId}`, { dimming: { brightness: v } }); } catch { brightness = prev; pushToast('그룹 밝기 실패'); }
  }

  /** 타이틀→lightId 맵을 전체 노트 스캔으로 구축. */
  async function buildTitleMap(): Promise<Map<string, string>> {
    const notes = await listNotesShared();
    const map = new Map<string, string>();
    for (const n of notes) {
      const line = firstBodyLineOf(n.xmlContent);
      const m = /^light:([0-9a-fA-F-]{36})$/.exec(line.trim());
      if (m) map.set(n.title.replace(/^조명::/, ''), m[1]);
    }
    return map;
  }

  async function pushMembership() {
    const titles = extractMembershipTitles(view.state.doc).map((t) => t.replace(/^조명::/, ''));
    const map = await buildTitleMap();
    const { lightIds, unresolved } = resolveMembershipIds(titles, map);
    if (unresolved.length) pushToast(`해석 못한 항목 ${unresolved.length}개 건너뜀`);
    try {
      if (!zoneId) {
        const created = (await hueCall('POST', 'zone', { type: 'zone', metadata: { name: '새 존', archetype: 'other' }, children: toChildrenRefs(lightIds) })) as { data?: Array<{ rid: string }> };
        const newId = created.data?.[0]?.rid;
        if (newId) writeZoneSignature(newId);
      } else {
        await hueCall('PUT', `zone/${zoneId}`, { children: toChildrenRefs(lightIds) });
      }
      pushToast('Hue에 반영됨'); await load();
    } catch { pushToast('Hue 반영 실패'); }
  }

  /** 본문 첫 줄 시그니처를 zone:<id> 로 갱신 — 새 존 생성 후 write-back. */
  function writeZoneSignature(newId: string) {
    const doc = view.state.doc; const first = doc.firstChild; if (!first) return;
    const start = first.nodeSize; const second = doc.childCount > 1 ? doc.child(1) : null;
    if (!second) return;
    const from = start + 1; const to = from + second.content.size;
    view.dispatch(view.state.tr.insertText(`zone:${newId}`, from, to));
  }

  async function recallScene(id: string) {
    try { await hueCall('PUT', `scene/${id}`, { recall: { action: 'active' } }); pushToast('씬 적용'); }
    catch { pushToast('씬 적용 실패'); }
  }
</script>

<div class="zone-control">
  <div class="zone-row">
    <button type="button" class="bulb-toggle" class:on={groupedOn} onclick={() => setGroupOn(!groupedOn)}>{groupedOn ? '전체 켜짐' : '전체 꺼짐'}</button>
    <button type="button" class="hue-refresh" onclick={load} aria-label="새로고침">⟳</button>
  </div>
  {#if glId}
    <label class="bulb-slider">전체 밝기
      <input type="range" min="1" max="100" value={brightness} oninput={(e) => setGroupBrightness(Number((e.target as HTMLInputElement).value))} />
    </label>
  {/if}
  {#if status}<span class="hue-status">{status}</span>{/if}
  <div class="zone-membership">
    <button type="button" onclick={pushMembership}>Hue에 반영</button>
  </div>
  {#if scenes.length}
    <div class="zone-scenes">
      {#each scenes as s (s.id)}<button type="button" onclick={() => recallScene(s.id)}>{s.metadata.name}</button>{/each}
    </div>
  {/if}
</div>

<style>
  .zone-control { display: flex; flex-direction: column; gap: 0.4rem; padding: 0.6rem; border: 1px solid var(--border, #ddd); border-radius: 8px; margin: 0.3rem 0; }
  .zone-row { display: flex; align-items: center; gap: 0.5rem; }
  .zone-scenes { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .zone-scenes button { padding: 0.2rem 0.6rem; border-radius: 999px; border: 1px solid var(--border, #ccc); }
  .bulb-toggle { padding: 0.3rem 0.8rem; border-radius: 999px; border: 1px solid var(--border, #ccc); }
  .bulb-toggle.on { background: #ffd766; }
  .bulb-slider { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; }
  .bulb-slider input[type='range'] { flex: 1; }
  .hue-refresh { margin-left: auto; }
  .hue-status { font-size: 0.85rem; opacity: 0.8; }
</style>
