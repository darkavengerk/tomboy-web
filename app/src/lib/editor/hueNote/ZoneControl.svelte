<script lang="ts">
  import type { EditorView } from '@tiptap/pm/view';
  // Task 6 fills this in; props accepted so the plugin wiring type-checks.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let { zoneId, view, getGuid, oninternallink }: { zoneId: string | null; view: EditorView; getGuid?: () => string; oninternallink?: (t: string) => void } = $props();
</script>

<div class="zone-control">존 노트 (구현 예정)</div>
