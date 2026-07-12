#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
用法：rsync_archive.sh --source PATH --dest /Volumes/<disk-or-share>/<archive-root> [--apply] [--allow-same-volume]

用 rsync 把 SOURCE 复制到 DEST/<SOURCE 文件名>/。默认 dry-run。
此脚本永远不删除源文件；删除源文件必须单独确认。

示例：
  rsync_archive.sh --source "$HOME/Downloads/Old exports" --dest "/Volumes/NAS/Mac-Archive/2026"
  rsync_archive.sh --source "$HOME/Downloads/Old exports" --dest "/Volumes/NAS/Mac-Archive/2026" --apply
USAGE
}

SRC=""
DEST_ROOT=""
APPLY=0
ALLOW_SAME_VOLUME=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      SRC="${2:-}"; shift 2 ;;
    --dest)
      DEST_ROOT="${2:-}"; shift 2 ;;
    --apply)
      APPLY=1; shift ;;
    --allow-same-volume)
      ALLOW_SAME_VOLUME=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "未知参数：$1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "$SRC" || -z "$DEST_ROOT" ]]; then
  usage >&2
  exit 2
fi

if [[ ! -e "$SRC" ]]; then
  echo "源路径不存在：$SRC" >&2
  exit 1
fi

case "$DEST_ROOT" in
  /Volumes/*) ;;
  *)
    echo "目标必须位于 /Volumes/... 下，避免误归档回内置盘：$DEST_ROOT" >&2
    exit 1 ;;
esac

VOLUME_NAME=$(printf '%s' "$DEST_ROOT" | awk -F/ '{print $3}')
VOLUME_ROOT="/Volumes/$VOLUME_NAME"
if [[ -z "$VOLUME_NAME" || ! -d "$VOLUME_ROOT" ]] || ! mount | grep -F " on $VOLUME_ROOT" >/dev/null 2>&1; then
  echo "目标卷看起来没有挂载：$VOLUME_ROOT" >&2
  echo "请先挂载外接盘或 SMB 共享，再重新运行。" >&2
  exit 1
fi

SRC_DEVICE=$(df -P "$SRC" 2>/dev/null | awk 'NR==2 {print $1}')
DEST_DEVICE=$(df -P "$VOLUME_ROOT" 2>/dev/null | awk 'NR==2 {print $1}')
if [[ "$ALLOW_SAME_VOLUME" -eq 0 && -n "$SRC_DEVICE" && -n "$DEST_DEVICE" && "$SRC_DEVICE" == "$DEST_DEVICE" ]]; then
  echo "源路径和目标路径似乎在同一个文件系统上（$SRC_DEVICE）。" >&2
  echo "只有在确实有意这样做时，才使用 --allow-same-volume。" >&2
  exit 1
fi

if [[ -x /opt/homebrew/bin/rsync ]]; then
  RSYNC_BIN=/opt/homebrew/bin/rsync
elif [[ -x /usr/local/bin/rsync ]]; then
  RSYNC_BIN=/usr/local/bin/rsync
else
  RSYNC_BIN=$(command -v rsync || true)
fi
if [[ -z "$RSYNC_BIN" ]]; then
  echo "未找到 rsync。请安装：brew install rsync" >&2
  exit 1
fi

RSYNC_VERSION=$("$RSYNC_BIN" --version 2>/dev/null | head -1 || true)
RSYNC_HELP=$("$RSYNC_BIN" --help 2>/dev/null || true)
ARGS=(-a)

if grep -q -- '--human-readable' <<<"$RSYNC_HELP"; then
  ARGS+=(--human-readable)
else
  ARGS+=(-h)
fi
if grep -q -- '--itemize-changes' <<<"$RSYNC_HELP"; then
  ARGS+=(--itemize-changes)
fi
if grep -q -- '--protect-args' <<<"$RSYNC_HELP"; then
  ARGS+=(--protect-args)
elif grep -Eq '(^|[[:space:]])-s[,[:space:]]' <<<"$RSYNC_HELP"; then
  ARGS+=(-s)
fi

if grep -q -- '--acls' <<<"$RSYNC_HELP"; then
  ARGS+=(-A)
fi
if grep -q -- '--xattrs' <<<"$RSYNC_HELP"; then
  ARGS+=(-X)
fi
# macOS openrsync can advertise --extended-attributes but fail on AppleDouble
# files during dry-runs. Prefer Homebrew rsync for metadata-heavy archives;
# otherwise copy file contents safely without forcing openrsync -E.
if ! grep -qi 'openrsync' <<<"$RSYNC_VERSION" && grep -q -- '--extended-attributes' <<<"$RSYNC_HELP"; then
  ARGS+=(-E)
fi
if grep -q -- '--fileflags' <<<"$RSYNC_HELP"; then
  ARGS+=(--fileflags)
fi
if grep -q -- '--crtimes' <<<"$RSYNC_HELP"; then
  ARGS+=(--crtimes)
fi
if grep -q -- '--info=' <<<"$RSYNC_HELP"; then
  ARGS+=(--info=progress2)
else
  ARGS+=(--progress)
fi

if [[ "$APPLY" -eq 0 ]]; then
  ARGS+=(--dry-run)
fi

BASE=$(basename "$SRC")
DEST_FINAL="$DEST_ROOT/$BASE"

cat <<EOF_STATUS
模式:        $([[ "$APPLY" -eq 1 ]] && echo 执行 || echo DRY-RUN)
rsync:      $RSYNC_BIN (${RSYNC_VERSION:-unknown})
源路径:      $SRC
目标路径:    $DEST_FINAL
源文件系统:  ${SRC_DEVICE:-unknown}
目标文件系统:${DEST_DEVICE:-unknown}
EOF_STATUS

if grep -qi 'openrsync' <<<"$RSYNC_VERSION"; then
  echo "提示：检测到 macOS openrsync。如需更完整保留元数据，建议安装 Homebrew rsync：brew install rsync" >&2
fi

if [[ "$APPLY" -eq 1 ]]; then
  mkdir -p "$DEST_FINAL"
fi

# Copy directory contents when SRC is a directory; copy file into DEST_FINAL when SRC is a file.
if [[ -d "$SRC" ]]; then
  "$RSYNC_BIN" "${ARGS[@]}" "$SRC/" "$DEST_FINAL/"
else
  if [[ "$APPLY" -eq 1 ]]; then
    mkdir -p "$DEST_FINAL"
  fi
  "$RSYNC_BIN" "${ARGS[@]}" "$SRC" "$DEST_FINAL/"
fi

cat <<'EOF_DONE'

完成。此脚本没有删除源文件。
下一步：从目标位置验证归档文件；如果确实要移除源文件，请单独确认后再执行。
EOF_DONE
