---
name: local-date-dir
description: 按日期计算、创建或打开本地目录时使用；默认采用年/年-月/年-月-日结构，提供可独立组合的路径、创建和打开操作。不处理网盘远端写入或挂载缓存。
metadata:
  internal: true
---

# 本地日期目录

将本 Skill 的 `scripts/date-dir` 绝对路径设为 `$DATE_DIR`。纯 POSIX Shell，使用系统自带的 `sh`、`date`、`mkdir` 等工具；运行和测试都不需要 Python、uv 或 Node。macOS 可直接运行；Linux 需要系统时区数据库，打开目录时需要 `xdg-open` 或自定义 opener。

根目录使用用户指定的位置或现有任务的明确输出目录；无从确定时询问，不默认写入主目录或当前目录。日期默认取**脚本运行机器的本地日期**；用户指定日期、时区或执行环境与用户不同时，用参数明确覆盖。

```sh
# 只计算路径，不创建目录。
"$DATE_DIR" path --root '/path/to/archive' --date 2026-10-30
# => /path/to/archive/2026/2026-10/2026-10-30

# 创建当天目录，可重复执行；只创建，不打开。
target=$("$DATE_DIR" create --root '/path/to/archive') || exit

# 明确要求打开时再组合，打开失败会返回非零码。
"$DATE_DIR" open "$target"
```

## 原子操作与组合

- `path`：计算日期路径，无文件系统写入。
- `ensure DIRECTORY`：确保任意本地目录存在，不理解日期。
- `open DIRECTORY`：仅打开已有目录，不创建；macOS 默认 Finder，Linux 默认 `xdg-open`。
- `create`：组合日期路径计算与 `ensure`，不包含 GUI 副作用。

需要复用同一天路径的多步工作流时，**只计算一次并传递结果**，避免午夜跨日：

```sh
target=$("$DATE_DIR" path --root '/path/to/archive' --timezone Asia/Shanghai) || exit
"$DATE_DIR" ensure "$target" >/dev/null || exit
# 后续归档、下载等操作由调用方执行，始终引用 "$target"。
"$DATE_DIR" open "$target"
```

每次成功仅在 stdout 输出一行绝对路径，诊断写入 stderr。退出码：`0` 成功、`1` 文件系统或打开程序失败、`2` 参数错误。组合时检查退出码，路径始终加引号。这里的“原子”指单一职责，不是事务：递归创建失败可能留下已创建的父目录；打开失败也不会回滚目录。

## 分层覆盖

优先级：**命令行参数 > 同名用途环境变量 > 内置默认值**。脚本不加载配置文件，也不改写 HOME、PATH 或调用方的 TZ。

| 参数 | 环境变量 | 默认值 |
| --- | --- | --- |
| `--root` | `DATE_DIR_ROOT` | 必须明确指定 |
| `--date` | `DATE_DIR_DATE` | 今天；严格校验真实日历日期 |
| `--timezone` | `DATE_DIR_TIMEZONE` | 系统本地时区（遵循进程 TZ）；仅计算今天时使用 |
| `--layout` | `DATE_DIR_LAYOUT` | `nested`：`YYYY/YYYY-MM/YYYY-MM-DD`；可选 `flat`：`YYYY-MM-DD` |
| `open --opener` | `DATE_DIR_OPENER` | 平台打开程序 |

前四项只供 `path/create` 使用；`ensure/open` 接收现成路径，不读取日期配置。`--opener` 是单个可执行文件路径，作为独立参数调用，不解析命令串；需要附加参数时由调用方提供包装脚本。显式时区从 `/usr/share/zoneinfo` 读取并验证；指定日期时使用 Shell 算术校验公历，不依赖 BSD/GNU `date` 的解析差异。

相对根目录按当前工作目录转成绝对路径，支持 `~`。本地路径遵循文件系统符号链接语义，不构成目录隔离边界。外置卷必须先由调用方确认已经挂载，避免卷缺失时把目录创建到系统盘。对于只读网盘挂载，使用对应服务的远端创建流程。

## 开发验证

在 Skill 目录执行：

```sh
sh tests/test-date-dir.sh
sh -n scripts/date-dir
# 可选静态检查，运行脚本本身不依赖 ShellCheck。
shellcheck -s sh scripts/date-dir tests/test-date-dir.sh
```

实现参考 PikPak 的日期层级与动作拆分，没有引入其 rclone、缓存失效或挂载可见性逻辑。日期校验与路径计算独立于目录创建和打开；CLI 为组合根，打开程序可替换。
