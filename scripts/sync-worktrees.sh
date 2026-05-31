#!/usr/bin/env bash
# sync-worktrees.sh — 로컬 main 변경분을 모든 worktree 브랜치에 머지.
#   - 충돌 나는 worktree는 자동으로 abort 하고 건너뜀(수동 처리 대상으로 보고만).
#   - main worktree 자신은 건드리지 않음.
#   - 첫 인자로 --rebase 를 주면 머지 대신 리베이스(장기 브랜치엔 비권장).
#
# 사용:  scripts/sync-worktrees.sh           # main 머지
#        scripts/sync-worktrees.sh --rebase  # main 위로 리베이스
set -uo pipefail

mode="merge"
[ "${1:-}" = "--rebase" ] && mode="rebase"

root=$(git rev-parse --show-toplevel) || { echo "git 저장소가 아님"; exit 1; }

# 오브젝트 DB는 worktree 공유 → fetch 는 한 번만.
echo "▶ fetch origin"
git -C "$root" fetch --quiet origin || echo "  ⚠ fetch 실패(오프라인?) — 로컬 main 기준으로 진행"

ok=0; skipped=0; conflict=0
while read -r wt; do
  branch=$(git -C "$wt" symbolic-ref --short HEAD 2>/dev/null) || continue
  if [ "$branch" = "main" ]; then continue; fi

  printf '▶ %-12s ' "$branch"

  # 워킹트리가 더럽거나 머지/리베이스 진행중이면 손대지 않음.
  if [ -n "$(git -C "$wt" status --porcelain)" ]; then
    echo "⏭  변경사항 있음 — 건너뜀"; skipped=$((skipped+1)); continue
  fi

  if [ "$mode" = "rebase" ]; then
    if git -C "$wt" rebase main >/dev/null 2>&1; then
      echo "✓ rebased"; ok=$((ok+1))
    else
      git -C "$wt" rebase --abort 2>/dev/null
      echo "⚠ 충돌 — 수동 처리"; conflict=$((conflict+1))
    fi
  else
    if git -C "$wt" merge --no-edit main >/dev/null 2>&1; then
      echo "✓ merged"; ok=$((ok+1))
    else
      git -C "$wt" merge --abort 2>/dev/null
      echo "⚠ 충돌 — 수동 처리"; conflict=$((conflict+1))
    fi
  fi
done < <(git -C "$root" worktree list --porcelain | awk '/^worktree/{print $2}')

echo "─────────────────────"
echo "완료: ${ok} 갱신 / ${skipped} 건너뜀(변경사항) / ${conflict} 충돌"
[ "$conflict" -gt 0 ] && echo "충돌 난 worktree는 해당 디렉터리에서 직접 'git merge main' 후 해결하세요."
exit 0
