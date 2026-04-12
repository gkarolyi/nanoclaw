#!/bin/bash
# git-safe: PreToolUse hook for Claude Code
# Prevents destructive git operations that can lose work.
# Source: https://dev.to/boucle2026/git-safe-stop-claude-code-from-force-pushing-your-branch-115f
#
# Blocked: force push, reset --hard, checkout ., restore (working tree),
#          clean -f, branch -D, stash drop/clear, --no-verify, push --delete,
#          reflog expire
#
# Config (.git-safe in repo root):
#   allow: push --force    # whitelist specific operations
#
# Env vars:
#   GIT_SAFE_DISABLED=1    Disable entirely
#   GIT_SAFE_LOG=1         Log checks to stderr

set -euo pipefail

if [ "${GIT_SAFE_DISABLED:-0}" = "1" ]; then exit 0; fi

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
if [ "$TOOL_NAME" != "Bash" ]; then exit 0; fi

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
if [ -z "$COMMAND" ]; then exit 0; fi

log() { [ "${GIT_SAFE_LOG:-0}" = "1" ] && echo "[git-safe] $*" >&2 || true; }

if ! echo "$COMMAND" | grep -q 'git\b' 2>/dev/null; then
  log "SKIP: no git command"; exit 0
fi

# Load allowlist from .git-safe config
ALLOWED=()
CONFIG="${GIT_SAFE_CONFIG:-.git-safe}"
if [ -f "$CONFIG" ]; then
  while IFS= read -r line; do
    line=$(echo "$line" | sed 's/#.*//' | xargs)
    [ -z "$line" ] && continue
    if [[ "$line" == allow:* ]]; then
      ALLOWED+=("$(echo "$line" | sed 's/^allow:\s*//' | xargs)")
    fi
  done < "$CONFIG"
fi

is_allowed() {
  local op="$1"
  for a in "${ALLOWED[@]+"${ALLOWED[@]}"}"; do
    [ "$a" = "$op" ] && { log "ALLOWED by config: $op"; return 0; }
  done
  return 1
}

block() {
  local msg="git-safe: $1"
  [ -n "${2:-}" ] && msg="$msg Suggestion: $2"
  printf '%s\n' "$msg" >&2
  exit 2
}

# Force push to main/master — unconditional, no allowlist override
echo "$COMMAND" | grep -qE 'git\s+push\s.*(--force|-f\b).*(main|master)' 2>/dev/null && \
  block "Force push to main/master is extremely dangerous." "This is blocked unconditionally."

# --no-verify skips pre-commit/pre-push hooks
echo "$COMMAND" | grep -qE 'git\s+(commit|merge|push|cherry-pick|revert|am)\s.*--no-verify' 2>/dev/null && \
  { is_allowed "no-verify" || block "--no-verify skips safety hooks (linting, tests, secret scanning)." "Remove --no-verify. Add 'allow: no-verify' to .git-safe if you must."; }

# force push (excluding --force-with-lease)
if echo "$COMMAND" | grep -qE 'git\s+push\s.*(--force\b|-[a-zA-Z]*f\b)' 2>/dev/null; then
  echo "$COMMAND" | grep -q '\-\-force-with-lease' 2>/dev/null || \
    { is_allowed "push --force" || block "Force push rewrites remote history and loses others' commits." "Use --force-with-lease, or add 'allow: push --force' to .git-safe."; }
fi

# git reset --hard
echo "$COMMAND" | grep -qE 'git\s+reset\s.*--hard' 2>/dev/null && \
  { is_allowed "reset --hard" || block "git reset --hard discards all uncommitted changes permanently." "Commit or stash first, or add 'allow: reset --hard' to .git-safe."; }

# git checkout . / checkout -- (discard working tree)
echo "$COMMAND" | grep -qE 'git\s+checkout\s+\.\s*$' 2>/dev/null && \
  { is_allowed "checkout ." || block "git checkout . discards all uncommitted working tree changes." "Commit or stash first."; }
echo "$COMMAND" | grep -qE 'git\s+checkout\s+--\s' 2>/dev/null && \
  { is_allowed "checkout --" || block "git checkout -- discards uncommitted changes to specified files." "Commit or stash first."; }
echo "$COMMAND" | grep -qE 'git\s+checkout\s+[^-][^ ]*\s+--\s' 2>/dev/null && \
  { is_allowed "checkout ref --" || block "git checkout <ref> -- <path> overwrites files from that ref." "Commit or stash first."; }

# git restore (working tree forms)
if echo "$COMMAND" | grep -qE 'git\s+restore\s' 2>/dev/null; then
  if echo "$COMMAND" | grep -qE '(--source|-s\s)' 2>/dev/null; then
    is_allowed "restore --source" || block "git restore --source overwrites files from a ref." "Commit or stash first."
  elif ! echo "$COMMAND" | grep -qE '\-\-staged' 2>/dev/null; then
    is_allowed "restore" || block "git restore without --staged discards uncommitted working tree changes." "Use --staged to unstage only, or commit/stash first."
  fi
fi

# git clean -f
echo "$COMMAND" | grep -qE 'git\s+clean\s.*-[a-zA-Z]*f' 2>/dev/null && \
  { is_allowed "clean -f" || block "git clean -f permanently deletes untracked files." "Use git clean -n (dry run) first."; }

# git branch -D
echo "$COMMAND" | grep -qE 'git\s+branch\s.*-[a-zA-Z]*D' 2>/dev/null && \
  { is_allowed "branch -D" || block "git branch -D force-deletes unmerged branches." "Use -d (lowercase) for merged branches only."; }

# git stash drop / clear
echo "$COMMAND" | grep -qE 'git\s+stash\s+drop' 2>/dev/null && \
  { is_allowed "stash drop" || block "git stash drop permanently deletes stashed changes." "Add 'allow: stash drop' to .git-safe to permit this."; }
echo "$COMMAND" | grep -qE 'git\s+stash\s+clear' 2>/dev/null && \
  { is_allowed "stash clear" || block "git stash clear permanently deletes all stashed changes." "Add 'allow: stash clear' to .git-safe to permit this."; }

# git push --delete / :branch
echo "$COMMAND" | grep -qE 'git\s+push\s.*--delete\s' 2>/dev/null && \
  { is_allowed "push --delete" || block "git push --delete removes remote branches or tags permanently." "Add 'allow: push --delete' to .git-safe to permit this."; }
echo "$COMMAND" | grep -qE 'git\s+push\s+\S+\s+:[^/\s]' 2>/dev/null && \
  { is_allowed "push --delete" || block "git push origin :branch removes a remote branch permanently." "Add 'allow: push --delete' to .git-safe to permit this."; }

# git reflog expire / delete
echo "$COMMAND" | grep -qE 'git\s+reflog\s+(expire|delete)' 2>/dev/null && \
  { is_allowed "reflog expire" || block "git reflog expire/delete destroys recovery data." "Almost never needed. Add 'allow: reflog expire' to .git-safe if required."; }

log "ALLOW: $COMMAND"
exit 0
