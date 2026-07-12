#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
用法：relocate_with_symlink.sh --source DIR --dest /Volumes/<disk-or-share>/<relocation-root> [--apply] [--force-dangerous]

永久迁移一个适合软链的目录：先复制到 DEST/<SOURCE 文件夹名>/，
再把原目录改名为带时间戳的备份，最后在原路径创建软链。
默认 dry-run，永远不删除备份。

示例：
  relocate_with_symlink.sh --source "$HOME/Models" --dest "/Volumes/FastExternal/Mac-Relocated"
  relocate_with_symlink.sh --source "$HOME/Models" --dest "/Volumes/FastExternal/Mac-Relocated" --apply
USAGE
}

SRC=""
DEST_ROOT=""
APPLY=0
FORCE_DANGEROUS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      SRC="${2:-}"; shift 2 ;;
    --dest)
      DEST_ROOT="${2:-}"; shift 2 ;;
    --apply)
      APPLY=1; shift ;;
    --force-dangerous)
      FORCE_DANGEROUS=1; shift ;;
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

SRC="${SRC%/}"
DEST_ROOT="${DEST_ROOT%/}"

if [[ ! -d "$SRC" ]]; then
  echo "源路径必须是已存在的目录：$SRC" >&2
  exit 1
fi
if [[ -L "$SRC" ]]; then
  echo "源路径已经是软链：$SRC" >&2
  exit 1
fi
HOME_DIR="${HOME:-$(printf '%s\n' ~)}"
if [[ "$SRC" == "/" || "$SRC" == "$HOME_DIR" ]]; then
  echo "拒绝直接迁移根目录或 HOME：$SRC" >&2
  exit 1
fi
case "$DEST_ROOT" in
  /Volumes/*) ;;
  *)
    echo "目标必须位于 /Volumes/... 下：$DEST_ROOT" >&2
    exit 1 ;;
esac

DANGEROUS_REASON=""
case "$SRC" in
  *'.photoslibrary'*|*/Library/Mail*|*/Library/Messages*|*/Library/Keychains*|*/Library/CloudStorage/*|*/Library/Mobile\ Documents/*|*/Dropbox*|*/OneDrive*|*/Google\ Drive*)
    DANGEROUS_REASON="app 库、云同步或供应商管理路径" ;;
  */Library/Application\ Support/*|*/Library/Containers/*|*/Library/Group\ Containers/*)
    DANGEROUS_REASON="app 拥有的支持 / 容器路径" ;;
esac
if [[ -n "$DANGEROUS_REASON" && "$FORCE_DANGEROUS" -eq 0 ]]; then
  echo "拒绝高风险软链迁移（$DANGEROUS_REASON）：$SRC" >&2
  echo "请改用 app 官方迁移流程；只有完全理解风险时才使用 --force-dangerous。" >&2
  exit 1
fi

VOLUME_NAME=$(printf '%s' "$DEST_ROOT" | awk -F/ '{print $3}')
VOLUME_ROOT="/Volumes/$VOLUME_NAME"
if [[ -z "$VOLUME_NAME" || ! -d "$VOLUME_ROOT" ]] || ! mount | grep -F " on $VOLUME_ROOT" >/dev/null 2>&1; then
  echo "目标卷看起来没有挂载：$VOLUME_ROOT" >&2
  exit 1
fi

SRC_DEVICE=$(df -P "$SRC" 2>/dev/null | awk 'NR==2 {print $1}')
DEST_DEVICE=$(df -P "$VOLUME_ROOT" 2>/dev/null | awk 'NR==2 {print $1}')
if [[ -n "$SRC_DEVICE" && -n "$DEST_DEVICE" && "$SRC_DEVICE" == "$DEST_DEVICE" ]]; then
  echo "源路径和目标路径似乎在同一个文件系统上（$SRC_DEVICE）；迁移不会释放内置盘空间。" >&2
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
if [[ "$APPLY" -eq 0 ]]; then
  ARGS+=(-n)
fi

BASE=$(basename "$SRC")
DEST_FINAL="$DEST_ROOT/$BASE"
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="$SRC.pre-symlink-backup-$STAMP"

cat <<EOF_STATUS
模式:        $([[ "$APPLY" -eq 1 ]] && echo 执行 || echo DRY-RUN)
源目录:      $SRC
目标目录:    $DEST_FINAL
备份目录:    $BACKUP
软链:        $SRC -> $DEST_FINAL
源文件系统:  ${SRC_DEVICE:-unknown}
目标文件系统:${DEST_DEVICE:-unknown}
rsync:       $RSYNC_BIN (${RSYNC_VERSION:-unknown})
EOF_STATUS

if grep -qi 'openrsync' <<<"$RSYNC_VERSION"; then
  echo "提示：检测到 macOS openrsync，中文文件名在输出中可能被转义。如需更好体验，建议安装 Homebrew rsync：brew install rsync" >&2
fi

if [[ "$APPLY" -eq 0 ]]; then
  cat <<'EOF_DRYRUN'

Dry-run 计划：
1. 把源目录内容复制到目标位置。
2. 把原源目录改名为带时间戳的备份目录。
3. 在原路径创建指向目标位置的软链。
4. 保留备份，直到用户在重启 / 重新挂载后验证 app 或工作流正常。
EOF_DRYRUN
else
  mkdir -p "$DEST_FINAL"
fi

"$RSYNC_BIN" "${ARGS[@]}" "$SRC/" "$DEST_FINAL/"

if [[ "$APPLY" -eq 1 ]]; then
  if [[ -e "$BACKUP" ]]; then
    echo "备份路径已存在：$BACKUP" >&2
    exit 1
  fi
  mv "$SRC" "$BACKUP"
  ln -s "$DEST_FINAL" "$SRC"
  cat <<EOF_DONE

迁移完成。备份已保留：
  $BACKUP

回滚：
  rm "$SRC"
  mv "$BACKUP" "$SRC"

在正常重启 / 重新挂载并确认软链路径可用前，不要删除备份。
EOF_DONE
else
  cat <<'EOF_DONE'

Dry-run 完成。没有移动目录，也没有创建软链。
EOF_DONE
fi
