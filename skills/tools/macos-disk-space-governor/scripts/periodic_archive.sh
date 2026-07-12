#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
用法：periodic_archive.sh --source DIR --dest /Volumes/<disk-or-share>/<archive-root> --min-age-days N [--apply] [--remove-source-files] [--exclude PATTERN]

把 SOURCE 中早于 N 天的文件归档到 DEST/<SOURCE 文件夹名>/，同时让 SOURCE
继续保持真实本地目录。默认 dry-run。适合 Downloads、导出目录、会议录像等
不可软链目录的周期迁移。

示例：
  periodic_archive.sh --source "$HOME/Downloads" --dest "/Volumes/NAS/Mac-Cold-Files" --min-age-days 45
  periodic_archive.sh --source "$HOME/Downloads" --dest "/Volumes/NAS/Mac-Cold-Files" --min-age-days 45 --apply
  periodic_archive.sh --source "$HOME/Downloads" --dest "/Volumes/NAS/Mac-Cold-Files" --min-age-days 45 --apply --remove-source-files
USAGE
}

SRC=""
DEST_ROOT=""
MIN_AGE_DAYS=""
APPLY=0
REMOVE_SOURCE=0
EXCLUDES=(".DS_Store" "._*" ".Spotlight-V100/*" ".Trashes/*" "*.photoslibrary/*")

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      SRC="${2:-}"; shift 2 ;;
    --dest)
      DEST_ROOT="${2:-}"; shift 2 ;;
    --min-age-days)
      MIN_AGE_DAYS="${2:-}"; shift 2 ;;
    --apply)
      APPLY=1; shift ;;
    --remove-source-files)
      REMOVE_SOURCE=1; shift ;;
    --exclude)
      EXCLUDES+=("${2:-}"); shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "未知参数：$1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "$SRC" || -z "$DEST_ROOT" || -z "$MIN_AGE_DAYS" ]]; then
  usage >&2
  exit 2
fi

SRC="${SRC%/}"
DEST_ROOT="${DEST_ROOT%/}"

if [[ ! -d "$SRC" ]]; then
  echo "源路径必须是已存在的目录：$SRC" >&2
  exit 1
fi
if [[ ! "$MIN_AGE_DAYS" =~ ^[0-9]+$ ]]; then
  echo "--min-age-days 必须是非负整数" >&2
  exit 2
fi
case "$DEST_ROOT" in
  /Volumes/*) ;;
  *)
    echo "目标必须位于 /Volumes/... 下：$DEST_ROOT" >&2
    exit 1 ;;
esac

VOLUME_NAME=$(printf '%s' "$DEST_ROOT" | awk -F/ '{print $3}')
VOLUME_ROOT="/Volumes/$VOLUME_NAME"
if [[ -z "$VOLUME_NAME" || ! -d "$VOLUME_ROOT" ]] || ! mount | grep -F " on $VOLUME_ROOT" >/dev/null 2>&1; then
  echo "目标卷看起来没有挂载：$VOLUME_ROOT" >&2
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
if ! grep -q -- '--files-from' <<<"$RSYNC_HELP"; then
  echo "当前 rsync 不支持 --files-from。请安装 Homebrew rsync：brew install rsync" >&2
  exit 1
fi

BASE=$(basename "$SRC")
DEST_FINAL="$DEST_ROOT/$BASE"
LIST_FILE=$(mktemp)
trap 'rm -f "$LIST_FILE"' EXIT

should_exclude() {
  local rel="$1"
  local pattern
  for pattern in "${EXCLUDES[@]}"; do
    case "$rel" in
      $pattern|./$pattern) return 0 ;;
    esac
  done
  return 1
}

(
  cd "$SRC"
  while IFS= read -r rel; do
    rel="${rel#./}"
    [[ -z "$rel" ]] && continue
    if should_exclude "$rel"; then
      continue
    fi
    printf '%s\n' "$rel"
  done < <(find . -type f -mtime +"$MIN_AGE_DAYS" -print 2>/dev/null | sort)
) > "$LIST_FILE"

COUNT=$(wc -l < "$LIST_FILE" | tr -d ' ')
SIZE_ESTIMATE=$(cd "$SRC" && while IFS= read -r rel; do [[ -f "$rel" ]] && du -sk "$rel" 2>/dev/null || true; done < "$LIST_FILE" | awk '{sum+=$1} END {printf "%.2f GiB", sum/1024/1024}')

cat <<EOF_STATUS
模式:          $([[ "$APPLY" -eq 1 ]] && echo 执行 || echo DRY-RUN)
源目录:        $SRC
目标目录:      $DEST_FINAL
年龄阈值:      $MIN_AGE_DAYS 天
匹配文件数:    $COUNT
预计大小:      $SIZE_ESTIMATE
移除源文件:    $([[ "$REMOVE_SOURCE" -eq 1 ]] && echo 是 || echo 否)
rsync:         $RSYNC_BIN (${RSYNC_VERSION:-unknown})
EOF_STATUS

if grep -qi 'openrsync' <<<"$RSYNC_VERSION"; then
  echo "提示：检测到 macOS openrsync，中文文件名在输出中可能被转义。如需更好体验，建议安装 Homebrew rsync：brew install rsync" >&2
fi

if [[ "$COUNT" -eq 0 ]]; then
  echo "没有匹配文件，无需归档。"
  exit 0
fi

if [[ "$REMOVE_SOURCE" -eq 1 && "$APPLY" -eq 0 ]]; then
  echo "提示：dry-run 时会忽略 --remove-source-files。" >&2
fi

ARGS=(-a --files-from="$LIST_FILE")
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
if [[ "$APPLY" -eq 0 ]]; then
  ARGS+=(-n)
else
  mkdir -p "$DEST_FINAL"
  if [[ "$REMOVE_SOURCE" -eq 1 ]]; then
    ARGS+=(--remove-source-files)
  fi
fi

"$RSYNC_BIN" "${ARGS[@]}" "$SRC/" "$DEST_FINAL/"

cat <<'EOF_DONE'

完成。源目录本身仍保持为真实目录。
如果这是 dry-run，请先检查文件列表，再决定是否定时或执行。
如果移除了源文件，请验证归档可用，并确保目标位置有备份。
EOF_DONE
