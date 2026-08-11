#!/bin/bash
# PreToolUse guard: an ISOLATED oracle must not read other vaults' ψ files.
#
# Tenant isolation (~/.claude/oracle-tenant-map.json) only scopes the Oracle DB.
# The same knowledge also sits on disk as markdown, so Read/Grep/Glob/Bash walk
# straight around the tenant filter. This closes that: when the session's vault
# is isolated, any ψ path outside its own root is denied (exit 2).
#
# Semantics match the DB side exactly: an isolated oracle sees ONLY its own
# tenant, so the shared projects/ψ vault is denied too (the engine has no
# mine+shared mode for documents).
#
# COST — this runs on every Read/Grep/Glob/Bash/Edit/Write, so the order of the
# checks IS the design:
#   1. marker file missing  -> exit, ~2ms (the normal case: nothing isolated)
#   2. marker present       -> one jq + bash builtins, ~8ms
# It was python first (~51ms/call measured on this box, always paid). bash+jq is
# the same logic 5x cheaper. Do not reintroduce a second implementation.
#
# Fails OPEN on anything unexpected — a broken guard must never block work.
set -o pipefail
MARK="${ORACLE_ISOLATION_MARK:-$HOME/.claude/oracle-isolation-ON}"
[ -e "$MARK" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

IN=$(cat) || exit 0

# One jq call: tool name, cwd, then every string that could name a path.
mapfile -t L < <(printf '%s' "$IN" | jq -r '
  (.tool_name // ""),
  (.cwd // ""),
  ([.tool_input.file_path?, .tool_input.path?, .tool_input.notebook_path?,
    .tool_input.pattern?, .tool_input.glob?, .tool_input.command?]
   | map(select(type == "string")) | .[]?)' 2>/dev/null) || exit 0
[ "${#L[@]}" -ge 2 ] || exit 0

TOOL="${L[0]}"
CWD="${L[1]}"
case "$TOOL" in
  Read|Grep|Glob|Bash|Edit|Write|NotebookEdit) ;;
  *) exit 0 ;;
esac
[ -n "$CWD" ] || exit 0

# The session's vault = nearest ancestor of cwd holding a ψ/ dir.
ROOT="$CWD"
while [ ! -d "$ROOT/ψ" ]; do
  parent="${ROOT%/*}"
  [ -n "$parent" ] && [ "$parent" != "$ROOT" ] || exit 0
  ROOT="$parent"
done
NAME="${ROOT##*/}"

# Is THIS vault isolated? The marker holds one vault dir name per line (written
# by oracle-tenant-migrate.ts, which normalises to basenames).
isolated=0
while IFS= read -r line; do
  [ "${line##*/}" = "$NAME" ] && { isolated=1; break; }
done < "$MARK"
[ "$isolated" = 1 ] || exit 0

deny() {
  printf 'Blocked by oracle memory isolation: %s is isolated, so it may only read its own ψ/ (%s). Requested: %s\n' \
    "$NAME" "$ROOT" "$1" >&2
  printf 'To share knowledge again: bun ~/.claude/oracle-tenant-migrate.ts --unisolate %s\n' "$NAME" >&2
  exit 2
}

check() { # $1 = a candidate path
  local raw="$1" p
  case "$raw" in *ψ*) ;; *) return 0 ;; esac
  case "$raw" in /*) p="$raw" ;; *) p="$CWD/$raw" ;; esac
  p="${p%%\**}"                     # /a/ψ/** -> /a/ψ/
  case "$p" in *"/ψ"*) ;; *) return 0 ;; esac
  [ "$p" = "$ROOT" ] && return 0
  case "$p" in "$ROOT"/*) return 0 ;; esac
  deny "$raw"
}

for ((i = 2; i < ${#L[@]}; i++)); do
  val="${L[$i]}"
  case "$val" in *ψ*) ;; *) continue ;; esac
  if [ "$TOOL" = Bash ]; then
    # a command line: inspect only the tokens that mention ψ
    for tok in $val; do
      case "$tok" in *ψ*) check "${tok//[\'\"();|\&<>]/}" ;; esac
    done
  else
    check "$val"
  fi
done
exit 0
