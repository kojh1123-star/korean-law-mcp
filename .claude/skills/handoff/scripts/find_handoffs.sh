#!/usr/bin/env bash
# List remote branches that carry .claude/handoff.md, newest commit first.
# Output: <branch>\t<last commit date>\t<last commit subject>
set -uo pipefail

FILE=".claude/handoff.md"

if ! git fetch --quiet --prune origin; then
  echo "warn: git fetch failed; listing cached remote refs only" >&2
fi

found=0
while IFS=$'\t' read -r ref date subject; do
  case "$ref" in origin|origin/HEAD) continue ;; esac
  if git cat-file -e "${ref}:${FILE}" 2>/dev/null; then
    printf '%s\t%s\t%s\n' "${ref#origin/}" "$date" "$subject"
    found=1
  fi
done < <(git for-each-ref --sort=-committerdate \
  --format='%(refname:short)%09%(committerdate:short)%09%(subject)' refs/remotes/origin)

if [ "$found" -eq 0 ]; then
  echo "no remote branch carries ${FILE}" >&2
  exit 1
fi
