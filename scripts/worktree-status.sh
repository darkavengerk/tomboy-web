#!/usr/bin/env bash
# worktree-status.sh — 모든 worktree 상태를 한 화면에 요약.
#   각 worktree 마다: 브랜치 / 변경파일 수 / main 대비 ahead·behind / 마지막 커밋.
#   main worktree 포함(맨 위). 네트워크 접근 없음(로컬 main 기준).
#
# 사용:  scripts/worktree-status.sh          # 요약 표
#        scripts/worktree-status.sh -v       # 변경 있는 worktree는 파일 목록까지
set -uo pipefail

verbose=0
[ "${1:-}" = "-v" ] && verbose=1

root=$(git rev-parse --show-toplevel) || { echo "git 저장소가 아님"; exit 1; }
base=$(git -C "$root" rev-parse --verify --quiet main) || { echo "main 브랜치 없음"; exit 1; }

# 색상(터미널일 때만)
if [ -t 1 ]; then
  R=$'\e[0m'; DIM=$'\e[2m'; GRN=$'\e[32m'; YEL=$'\e[33m'; CYN=$'\e[36m'; RED=$'\e[31m'
else
  R=; DIM=; GRN=; YEL=; CYN=; RED=
fi

printf '%b\n' "${DIM}브랜치       상태     ahead/behind(main)  마지막 커밋${R}"
printf '%b\n' "${DIM}──────────────────────────────────────────────────────────────────${R}"

while read -r wt; do
  branch=$(git -C "$wt" symbolic-ref --short HEAD 2>/dev/null) || branch="(detached)"

  # 변경 파일 수
  dirty=$(git -C "$wt" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  if [ "$dirty" -eq 0 ]; then
    state="${GRN}clean${R}    "
  else
    state="${YEL}±${dirty}${R}"
    # 정렬용 패딩
    pad=$((9 - ${#dirty} - 1)); [ "$pad" -lt 0 ] && pad=0
    state="${state}$(printf '%*s' "$pad" '')"
  fi

  # main 대비 ahead/behind (main worktree 자신은 0/0)
  if counts=$(git -C "$wt" rev-list --left-right --count "${base}...HEAD" 2>/dev/null); then
    behind=$(echo "$counts" | awk '{print $1}')
    ahead=$(echo "$counts" | awk '{print $2}')
  else
    behind=0; ahead=0
  fi
  ab=""; abplain=""
  [ "$ahead"  -gt 0 ] && { ab="${ab}${GRN}↑${ahead}${R}";  abplain="${abplain}↑${ahead}"; }
  [ "$behind" -gt 0 ] && { ab="${ab}${RED}↓${behind}${R}"; abplain="${abplain}↓${behind}"; }
  [ -z "$ab" ] && { ab="${DIM}·${R}"; abplain="·"; }
  # 보이는 글자 수 기준으로 패딩(색 코드가 정렬을 망치지 않도록)
  abpad=$((12 - ${#abplain})); [ "$abpad" -lt 1 ] && abpad=1
  ab="${ab}$(printf '%*s' "$abpad" '')"

  last=$(git -C "$wt" log -1 --format='%h %s %C(reset)%C(dim)(%cr)' --color=always 2>/dev/null)

  printf '%b%-12s%b %b  %b %s\n' "$CYN" "$branch" "$R" "$state" "$ab" "$last"

  if [ "$verbose" -eq 1 ] && [ "$dirty" -gt 0 ]; then
    git -C "$wt" status --porcelain 2>/dev/null | sed "s/^/             ${DIM}/;s/\$/${R}/"
  fi
done < <(git -C "$root" worktree list --porcelain | awk '/^worktree/{print $2}')

exit 0
