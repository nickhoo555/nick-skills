#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
用法：triage.sh [--persona office|engineer|mixed] [--target PATH] [--run-ncdu]

只读盘点 macOS 内置盘压力：显示磁盘状态、/Volumes 挂载目标、
目标目录顶层占用，以及按用户类型划分的清理 / 归档候选项。

示例：
  triage.sh --persona office --target "$HOME"
  triage.sh --persona engineer --target "$HOME" --run-ncdu
USAGE
}

PERSONA="mixed"
HOME_DIR="${HOME:-$(printf '%s\n' ~)}"
TARGET="$HOME_DIR"
RUN_NCDU=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --persona)
      PERSONA="${2:-}"; shift 2 ;;
    --target)
      TARGET="${2:-}"; shift 2 ;;
    --run-ncdu)
      RUN_NCDU=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "未知参数：$1" >&2; usage; exit 2 ;;
  esac
done

case "$PERSONA" in
  office|engineer|mixed) ;;
  *) echo "--persona 必须是 office、engineer 或 mixed" >&2; exit 2 ;;
esac

if [[ ! -e "$TARGET" ]]; then
  echo "目标不存在：$TARGET" >&2
  exit 1
fi

have() { command -v "$1" >/dev/null 2>&1; }

size_gb() {
  local path="$1"
  if [[ -e "$path" ]]; then
    du -xg -d 0 "$path" 2>/dev/null | awk '{print $1 " GB\t" $2}' || true
  fi
}

section() { printf '\n== %s ==\n' "$1"; }

section "工具检查"
if have brew; then
  echo "brew: $(command -v brew)"
else
  echo "brew: 未找到（如需安装工具，先安装 Homebrew）"
fi

if have ncdu; then
  echo "ncdu: $(command -v ncdu)"
else
  echo "ncdu: 未找到。建议安装：brew install ncdu"
fi

if have rsync; then
  echo "rsync: $(command -v rsync) ($(rsync --version 2>/dev/null | head -1 || echo unknown))"
else
  echo "rsync: 未找到。建议安装：brew install rsync"
fi

section "内置盘 / 目标卷状态"
df -h / "$HOME_DIR" "$TARGET" 2>/dev/null | awk 'NR==1 || !seen[$0]++'
if [[ -d /System/Volumes/Data ]]; then
  df -h /System/Volumes/Data 2>/dev/null || true
fi

section "/Volumes 下已挂载的外置盘 / SMB 候选目标"
if mount | grep -E ' on /Volumes/' >/dev/null 2>&1; then
  mount | grep -E ' on /Volumes/' || true
  df -h /Volumes/* 2>/dev/null || true
else
  echo "未检测到 /Volumes 挂载。归档前请先挂载外接盘或 SMB 共享。"
fi

section "目标目录顶层占用：$TARGET"
echo "使用：du -xg -d 1 <target>（只读；仅同一文件系统）"
du -xg -d 1 "$TARGET" 2>/dev/null | sort -nr | head -40 || true

section "办公室用户常见归档候选项"
for p in \
  "$HOME_DIR/Downloads" \
  "$HOME_DIR/Desktop" \
  "$HOME_DIR/Documents" \
  "$HOME_DIR/Movies" \
  "$HOME_DIR/Pictures" \
  "$HOME_DIR/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings" \
  "$HOME_DIR/Library/Containers/us.zoom.xos/Data/Documents"; do
  size_gb "$p"
done

if [[ "$PERSONA" == "engineer" || "$PERSONA" == "mixed" ]]; then
  section "工程师常见可重建 / 可删除候选项"
  for p in \
    "$HOME_DIR/Library/Developer/Xcode/DerivedData" \
    "$HOME_DIR/Library/Developer/Xcode/Archives" \
    "$HOME_DIR/Library/Developer/CoreSimulator/Devices" \
    "$HOME_DIR/Library/Caches/Homebrew" \
    "$HOME_DIR/Library/Caches/pip" \
    "$HOME_DIR/Library/pnpm/store" \
    "$HOME_DIR/.pnpm-store" \
    "$HOME_DIR/.npm" \
    "$HOME_DIR/.yarn" \
    "$HOME_DIR/.gradle/caches" \
    "$HOME_DIR/.cache" \
    "$HOME_DIR/Library/Containers/com.docker.docker"; do
    size_gb "$p"
  done
fi

section "建议下一步扫描"
echo "ncdu -x \"$TARGET\""
echo "ncdu -x \"$HOME_DIR/Downloads\""
if [[ "$PERSONA" == "engineer" || "$PERSONA" == "mixed" ]]; then
  echo "ncdu -x \"$HOME_DIR/Library/Developer\""
  echo "docker system df   # if Docker is installed and relevant"
fi

if [[ "$RUN_NCDU" -eq 1 ]]; then
  if have ncdu; then
    section "Running ncdu"
    ncdu -x "$TARGET"
  else
    echo "无法运行 ncdu，因为尚未安装。请使用：brew install ncdu" >&2
    exit 1
  fi
fi
