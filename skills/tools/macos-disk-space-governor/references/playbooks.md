# 场景手册

## 通用安全规则

- `~/Library`、app 库、云同步目录默认视为 app 管理，不当作普通文件夹。
- 不手工改 `.photoslibrary`、Mail、Messages、Keychains、Docker 磁盘镜像、VM、数据库、云盘控制目录。
- 不把 `rm -rf` 当第一选择。优先 app 内清理、包管理器清理、归档验证后再删除。
- `ncdu` 默认带 `-x`，避免扫进外置盘或 SMB。
- 归档到 `/Volumes/...` 前，先检查挂载、空间、写入权限。
- 软链是永久迁移，不是清理小技巧；只给安全目录使用。
- 定时任务先 report-only 或 dry-run，不先做删除、移源文件、创建软链。

## 工具安装

```bash
brew install ncdu rsync
```

只读扫描：

```bash
ncdu -x "$HOME"
ncdu -x ~/Downloads
ncdu -x ~/Documents
```

系统级扫描可能需要给 Terminal / Codex Full Disk Access，也可能需要 `sudo`：

```bash
sudo ncdu -x /System/Volumes/Data
```

## 非技术办公室白领

### 说人话

不要说“清理 inode / cache / symlink”。用这些分类：

- 下载和安装包
- 桌面临时文件
- 文档和导出文件
- 会议录像 / 录屏
- 图片、视频、压缩包
- 可以归档但不常打开的旧资料

### 优先看哪里

1. `~/Downloads`：安装包、ZIP、重复 PDF、旧导出、录屏。
2. 桌面和文档：项目旧版本、大文件、重复资料。
3. 会议工具目录：Zoom、Teams、腾讯会议、飞书 / Lark、微信文件。
4. Keynote / PowerPoint / PDF / 视频导出目录。
5. 废纸篓：确认近期没有恢复需求后再清空。

### 不建议手工动哪里

- `~/Library/Mail`、`~/Library/Messages`、`~/Library/Application Support`。
- Photos 照片图库内部；需要迁移时走 Photos 支持的整体迁移流程，且不建议放活跃 SMB。
- iCloud Drive、Dropbox、OneDrive、Google Drive 内部控制文件；优先用“移除本地下载 / 仅在线”功能。

### 推荐长期方案

1. 每月或每两周提醒检查一次：`scripts/triage.sh --persona office --target "$HOME"`。
2. Downloads、会议录像、导出目录用不可软链的周期归档。
3. 源目录保持真实目录，不替换成软链。
4. 删除源文件前，先从外置盘 / SMB 打开 3 个样本确认。

## 技术工程师

### 常见可删除 / 可重建对象

- Xcode：`~/Library/Developer/Xcode/DerivedData`、旧 Archives、不可用 simulator/runtime。
- iOS Simulator：`~/Library/Developer/CoreSimulator/Devices`，先确认当前不需要。
- Docker Desktop：未使用镜像、容器、volume；优先 Docker CLI/UI prune，不直接删 disk image。
- Node：repo 内 `node_modules`、pnpm/npm/yarn cache，可重建时处理。
- Java / Android：Gradle cache、Android build output、旧 emulator image。
- Python：`.venv`、`.tox`、pip/uv cache，可重建时处理。
- Rust / Go：`target`、module/build cache。
- Homebrew：优先 `brew cleanup --dry-run`，确认后 `brew cleanup`。

### 工程师长期治理

- 能用工具配置目录或环境变量时，优先于软链。
- 冲刺期每周看一次，稳定期每月看一次。
- 交付物、旧包、日志、导出文件适合周期归档。
- 模型、数据集、只读素材库可评估软链迁移。
- 活跃源码仓库、数据库、Docker disk image、VM、高频小文件目录不建议放 SMB。

可用命令示例：

```bash
brew cleanup --dry-run
brew cleanup
xcrun simctl delete unavailable

docker system df
# prune 前必须确认
docker system prune
```

寻找大生成目录：

```bash
find "$HOME" -maxdepth 6 -name node_modules -type d -prune 2>/dev/null
find "$HOME" -maxdepth 6 \( -name .venv -o -name target -o -name build -o -name dist \) -type d -prune 2>/dev/null
```

## 外置存储

### 外接磁盘

- Mac-only 归档优先 APFS，保留元数据更好。
- 跨平台交换可用 exFAT，但提醒权限 / 元数据限制。
- 如果外置盘成了唯一副本，就还没完成备份。

### SMB 私有云

- 确认挂载在 `/Volumes/<share>`，并用 `df -h /Volumes/<share>` 看文件系统和剩余空间。
- SMB 适合冷归档，不适合活体 app library、数据库、VM、Docker disk image、活跃仓库。
- 网络会中断，所以用 `rsync`，让任务可重跑、可修复。

## 报告模板

```markdown
## 内置盘治理方案

一句话判断：<内置盘当前是紧急 / 观察 / 健康；主要压力来自哪里>。

| 优先级 | 路径 / 类别 | 术 | 预计空间 | 动作 | 风险 |
|---|---|---:|---:|---|---|
| 1 | <path/category> | 提醒检查 / 一次性归档 / 周期归档 / 软链迁移 / 删除重建 | <size> | <命令或 app 操作> | 低/中/高 |

确认门：
1. <dry-run 命令>
2. <apply / 定时 / 删除 / 软链命令，如有>

验证：
- 从目标盘打开 3 个样本文件。
- 软链迁移时确认原路径可访问、备份目录存在。
- 重新运行 `df -h`、`du` 或 `ncdu -x` 确认释放效果。

回滚：
- <如何从归档恢复，或如何移除软链并恢复备份>。
```
