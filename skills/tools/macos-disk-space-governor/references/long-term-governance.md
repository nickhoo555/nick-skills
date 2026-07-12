# 长期治理：道与术

## 道：治理的对象不是垃圾，而是秩序

空间紧张通常不是因为某个“垃圾文件”，而是缺少数据生命周期：创建、使用、沉淀、归档、删除。这个 skill 的目标不是让用户每次焦虑时清一波，而是帮助他们建立一套可持续的流动机制。

核心比喻：

- **内置盘 = 热工作台**：放正在发生的事，要求快、稳、随时可用。
- **外置盘 / SMB = 冷库**：放已经沉淀的资料，要求容量大、可恢复、可复查。
- **软链 = 路径契约重写**：不是省空间小技巧，而是让旧路径指向新位置；必须谨慎。

## 三层术

### 1. 看见：提醒检查

目的：建立节奏和可见性，不自动改变文件。

适合：所有用户，尤其是非技术用户或初次治理。

做法：

```bash
scripts/triage.sh --persona office --target "$HOME"
# 或
scripts/triage.sh --persona engineer --target "$HOME"
```

建议阈值：

- 紧急：内置盘低于 10% 或低于 30 GB。
- 观察：内置盘剩余 10–20%。
- 健康：高于 20%，且没有明显快速增长目录。

建议节奏：

- 紧急期：每周一次，直到稳定。
- 观察期：每 2–4 周一次。
- 健康期：每月或每季度一次。

提醒文案可以是：

```text
检查 Mac 内置盘压力：运行只读盘点，汇报剩余空间、主要增长目录，并给出安全的归档或清理建议；不要自动删除或移动文件。
```

### 2. 流动：不可软链的周期归档

目的：源目录保持真实本地目录，让冷文件自动离开热工作台。

适合：

- `~/Downloads` 中超过 30–90 天的文件。
- 会议录像、录屏、导出视频。
- 扫描件、导入目录、导出目录。
- 工程交付物、旧日志、历史构建包。

不适合：

- app 库、数据库、Photos/Mail/Messages 内部目录。
- 云盘同步根目录或供应商控制目录。
- 活跃源码仓库、VM、数据库。

dry-run：

```bash
scripts/periodic_archive.sh \
  --source "$HOME/Downloads" \
  --dest "/Volumes/Archive/Mac-Cold-Files" \
  --min-age-days 45
```

确认后执行复制：

```bash
scripts/periodic_archive.sh \
  --source "$HOME/Downloads" \
  --dest "/Volumes/Archive/Mac-Cold-Files" \
  --min-age-days 45 \
  --apply
```

确认归档可用且目标盘有备份后，才考虑移除源文件：

```bash
scripts/periodic_archive.sh \
  --source "$HOME/Downloads" \
  --dest "/Volumes/Archive/Mac-Cold-Files" \
  --min-age-days 45 \
  --apply \
  --remove-source-files
```

原则：先让用户看到“会移动哪些文件”；至少经历几次 dry-run 成功后，再考虑定时执行 apply；删除源文件永远是单独确认。

### 3. 重构：可软链的永久迁移

目的：把某个大目录长期放到外置盘 / SMB，但保留原路径。

只有全部满足时才建议：

- 目录是用户可控目录，不是 app 数据库或云同步控制目录。
- 目录读多写少，或应用明确支持软链。
- 外置盘 / SMB 在使用时可靠挂载。
- 用户接受目标未挂载时原路径会失效。
- 有回滚备份，最好还有第二份备份。

较适合：

- 大模型目录。
- 数据集。
- 只读素材库。
- 低频但需要保留旧路径的个人资料库。

不适合：

- `~/Downloads`、桌面、活跃 `~/Documents` 根目录。
- Photos、Mail、Messages、Keychains、浏览器 profile。
- iCloud、Dropbox、OneDrive、Google Drive 根目录。
- Docker 磁盘镜像、VM、数据库、活跃源码仓库，尤其在 SMB 上。

先 dry-run：

```bash
scripts/relocate_with_symlink.sh \
  --source "$HOME/Models" \
  --dest "/Volumes/FastExternal/Mac-Relocated"
```

确认后执行：

```bash
scripts/relocate_with_symlink.sh \
  --source "$HOME/Models" \
  --dest "/Volumes/FastExternal/Mac-Relocated" \
  --apply
```

回滚形态：

```bash
rm "$HOME/Models"
mv "$HOME/Models.pre-symlink-backup-<timestamp>" "$HOME/Models"
```

不要急着删备份；至少验证一次重启、重新挂载、正常打开文件。

## 决策矩阵

| 现象 | 应选的术 | 原因 |
|---|---|---|
| 用户只想别再突然爆盘 | 定时提醒检查 | 先建立可见性，风险最低 |
| 目录持续增长，但路径必须是真目录 | 不可软链的周期归档 | 保持原使用习惯，冷文件离开内置盘 |
| 文件已经不活跃，但偶尔要查 | 一次性归档 | 简单、可逆、低风险 |
| 目录很大、读多写少、路径要保留 | 可软链的永久迁移 | 释放内置盘，同时维持路径契约 |
| 是缓存或构建产物 | 删除 / 重建 / 配置工具路径 | 不应为了可重建数据复杂迁移 |
| 是 app 库、云同步、数据库 | 保留本地或用 app 官方迁移 | 手动软链和 SMB 容易损坏或混乱 |

## 自动化边界

好的自动化：

- “每周五 10 点跑只读检查，给出建议。”
- “每月 dry-run 归档 Downloads 中超过 60 天的文件，并展示列表。”
- “确认后再把 dry-run 变成 apply。”

坏的自动化：

- “自动删除旧文件。”
- “每天把 app library 搬到 SMB。”
- “在未验证挂载和回滚前替换成软链。”

## 给 agent 的原则

- 先解释“为什么这个路径适合 / 不适合某种术”。
- 先给 dry-run，再给 apply。
- 先归档，再删除。
- 先保留备份，再创建软链。
- 先让用户确认目标盘和风险，再写定时任务。
