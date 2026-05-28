/**
 * In-memory index of link-mark targets. Two coupled maps kept as mutual
 * inverses so the rename sweep can find affected notes in O(1) and the
 * diff-on-write path can compute "previous targets" without an extra IDB
 * read.
 *
 * Invariant: forwardLinks.get(g).has(t) ⇔ backwardLinks.get(t).has(g).
 * Every mutation goes through `updateNote`, which preserves this.
 *
 * Index is in-memory only — rebuilt at app shell mount via
 * `installBacklinkIndex()`. See spec
 * `docs/superpowers/specs/2026-05-28-backlink-index-design.md`.
 */

const forwardLinks = new Map<string, Set<string>>();
const backwardLinks = new Map<string, Set<string>>();

const EMPTY: ReadonlySet<string> = new Set();

const LINK_RE = /<link:(?:internal|broken)>([^<]*)<\/link:(?:internal|broken)>/g;

function xmlUnescape(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function extractLinkTargets(xml: string): Set<string> {
  const out = new Set<string>();
  for (const m of xml.matchAll(LINK_RE)) {
    out.add(xmlUnescape(m[1]));
  }
  return out;
}

export function updateNote(guid: string, xml: string, deleted: boolean): void {
  const oldTargets = forwardLinks.get(guid) ?? EMPTY;
  const newTargets = deleted ? EMPTY : extractLinkTargets(xml);

  for (const t of oldTargets) {
    if (newTargets.has(t)) continue;
    const set = backwardLinks.get(t);
    if (!set) continue;
    set.delete(guid);
    if (set.size === 0) backwardLinks.delete(t);
  }
  for (const t of newTargets) {
    if (oldTargets.has(t)) continue;
    let set = backwardLinks.get(t);
    if (!set) backwardLinks.set(t, (set = new Set()));
    set.add(guid);
  }

  if (newTargets.size === 0) forwardLinks.delete(guid);
  else forwardLinks.set(guid, newTargets as Set<string>);
}

export function getSourcesFor(title: string): ReadonlySet<string> | undefined {
  return backwardLinks.get(title);
}

export function clear(): void {
  forwardLinks.clear();
  backwardLinks.clear();
}

export function __test__getForward(): ReadonlyMap<string, ReadonlySet<string>> {
  return forwardLinks;
}
export function __test__getBackward(): ReadonlyMap<string, ReadonlySet<string>> {
  return backwardLinks;
}
