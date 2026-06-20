<script lang="ts">
  import { onMount } from 'svelte';
  import type { EditorView } from '@tiptap/pm/view';
  import type { Node as PMNode, Schema } from '@tiptap/pm/model';
  import { Fragment } from '@tiptap/pm/model';
  import { hueCall, getHueContext, HueError } from '$lib/hue/hueClient.js';
  import type { HueLight, HueRoom, HueZone } from '$lib/hue/hueTypes.js';
  import { planLightImports, planRoomImports, planZoneImports } from '$lib/hue/hueImport.js';
  import { firstBodyLineOf } from '$lib/hue/noteBody.js';
  import { createNote, ensureUniqueTitle, listNotesShared } from '$lib/core/noteManager.js';
  import { pushToast } from '$lib/stores/toast.js';

  let { view, oninternallink }: { view?: EditorView; oninternallink?: (t: string) => void } = $props();

  let paired = $state(false);
  let busy = $state(false);

  onMount(async () => { paired = (await getHueContext()) !== null; });

  async function existingIds(sig: RegExp): Promise<Set<string>> {
    const notes = await listNotesShared();
    const ids = new Set<string>();
    for (const n of notes) {
      const m = sig.exec(firstBodyLineOf(n.xmlContent).trim());
      if (m) ids.add(m[1]);
    }
    return ids;
  }

  async function importAll() {
    busy = true;
    try {
      const lights = ((await hueCall('GET', 'light')) as { data?: HueLight[] }).data ?? [];
      const rooms = ((await hueCall('GET', 'room')) as { data?: HueRoom[] }).data ?? [];
      const zones = ((await hueCall('GET', 'zone')) as { data?: HueZone[] }).data ?? [];
      const lightPlan = planLightImports(lights, await existingIds(/^light:([0-9a-fA-F-]{36})$/));
      const roomPlan = planRoomImports(rooms, await existingIds(/^room:([0-9a-fA-F-]{36})$/));
      const zonePlan = planZoneImports(zones, await existingIds(/^zone:([0-9a-fA-F-]{36})$/));
      for (const it of [...lightPlan, ...roomPlan, ...zonePlan]) {
        const title = await ensureUniqueTitle(it.title);
        await createNote({ title, bodyFirstLine: it.bodyFirstLine });
      }
      if (view) await writeBundles();
      const created = lightPlan.length + roomPlan.length + zonePlan.length;
      pushToast(created ? `전구 ${lightPlan.length} · 방 ${roomPlan.length} · 존 ${zonePlan.length}개 생성` : '새 항목 없음 — 목록 갱신');
    } catch (e) {
      pushToast(e instanceof HueError && e.kind === 'no_bridge' ? '설정에서 Hue를 먼저 연결' : '조명 브릿지에 연결 안 됨');
    } finally { busy = false; }
  }

  /**
   * 묶음 블록 빌더 — parser.ts 가 인식하는 정확한 PMNode 구조를 생성한다.
   *
   * BUNDLE_RE = /^\s*(?:노트\s*)?묶음:(\d+)?(?::(\d+))?\s*$/
   * 체크박스 뒤의 텍스트가 BUNDLE_RE 에 매칭되어야 하고,
   * 체크박스 앞 prefix 의 trimmed 형태는 '' 이거나 ':' 로 끝나야 한다.
   * '전구: ' 의 trimmed = '전구:' → ':' 로 끝나므로 허용된다.
   *
   * 결과 구조: [paragraph([text(label), checkbox, text('묶음:50')]), bulletList([...])]
   */
  function bundleBlock(schema: Schema, label: string, titles: string[]): PMNode[] {
    const cb = schema.nodes.inlineCheckbox;
    const li = schema.nodes.listItem;
    const bl = schema.nodes.bulletList;
    const p = schema.nodes.paragraph;
    const link = schema.marks.tomboyInternalLink;

    // 키워드 paragraph: 접두 라벨 + 체크박스 + '묶음:50'
    // 파서는 체크박스 바로 앞 텍스트를 prefix 로 보고 trimmed.endsWith(':') 를 체크함.
    // '전구: '.trim() = '전구:' — 끝이 ':' 이므로 PASS.
    const head = p.create(null, [
      schema.text(label),
      cb.create({ checked: false }),
      schema.text('묶음:50')
    ]);

    const items = titles.map((t) =>
      li.create(null, p.create(null, [schema.text(t, [link.create({ target: t })])]))
    );
    const list = bl.create(null, items.length ? items : [li.create(null, p.create())]);
    return [head, list];
  }

  async function writeBundles() {
    const notes = await listNotesShared();
    const lightTitles = notes
      .filter((n) => /^light:/.test(firstBodyLineOf(n.xmlContent).trim()))
      .map((n) => n.title);
    const roomTitles = notes
      .filter((n) => /^room:/.test(firstBodyLineOf(n.xmlContent).trim()))
      .map((n) => n.title);
    const zoneTitles = notes
      .filter((n) => /^zone:/.test(firstBodyLineOf(n.xmlContent).trim()))
      .map((n) => n.title);

    const schema = view!.state.schema;
    const blocks = [
      ...bundleBlock(schema, '전구: ', lightTitles),
      ...bundleBlock(schema, '방: ', roomTitles),
      ...bundleBlock(schema, '존: ', zoneTitles)
    ];

    const doc = view!.state.doc;
    // 제목 노드(index 0) 바로 다음부터 문서 끝까지 교체
    const from = doc.firstChild ? doc.firstChild.nodeSize : 0;
    // 멱등: 본문이 이미 동일하면 dispatch 안 함(반복 가져오기 시 undo 스팸·위젯 리마운트 방지).
    if (Fragment.from(blocks).eq(doc.slice(from, doc.content.size).content)) return;
    view!.dispatch(
      view!.state.tr
        .replaceWith(from, doc.content.size, blocks)
        .setMeta('addToHistory', false)
    );
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
      <button type="button" disabled={busy} onclick={importAll}>가져오기</button>
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
