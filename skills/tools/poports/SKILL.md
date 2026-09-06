---
name: poports
description: 用 SQLite 统一登记、分配、查询和释放服务端口，兼容 CSV 导入导出；为新服务注册端口、避免 Agent 并发重复分配或维护端口台账时使用，提供调用方一键执行的幂等 CLI。
---

# poports

SQLite 是唯一真源；CSV 只用于显式导入、导出，不做双向自动同步。调用方使用 CLI，不自行计算端口或改库。

## 接入与一键注册

将 `POPORTS` 设为本 Skill 的 `scripts/poports` 绝对路径。启动器优先用 `uv`，不可用时用 `python3`；要求 Python 3.10+、标准库，无需数据库服务。

首次接入现有数据库：

```bash
"$POPORTS" configure --db /absolute/path/poports.sqlite3
```

若用户要求创建台账或迁移 CSV，执行一次初始化；原 CSV 保持不变，目标数据库存在时拒绝覆盖：

```bash
"$POPORTS" init --from /absolute/path/data/index.csv
# 没有旧数据时用 "$POPORTS" init。
```

默认数据库为 `${XDG_DATA_HOME:-~/.local/share}/poports/poports.sqlite3`。覆盖优先级：`--db` > `POPORTS_DB` 环境变量 > `${XDG_CONFIG_HOME:-~/.config}/poports/config.json` > 默认路径。错误路径直接失败，不隐式新建或切换到别的台账。Skill 更新不会覆盖配置或数据。

此后调用方只需一行：

```bash
PORT=$("$POPORTS" register my-service --app web --host mac-mini --output port)
# 将 "$PORT" 传给应用自己的启动配置。
```

同一 `服务 + 应用 + 主机` 重复注册返回原端口。多入口用不同 `--app`，跨机器用稳定的 `--host`；省略时空值也是身份的一部分，不猜本机名。可将启动器软链到用户 PATH 中，直接用 `poports`；先检查同名命令，安装时保持已有文件不变。

## 维护命令

```bash
"$POPORTS" list --service my-service
"$POPORTS" get 10175
"$POPORTS" register my-service --app api --port 10176 --set 分类=自建 --set 内网地址=http://localhost:3000
"$POPORTS" update 10176 --set 域名=https://api.example.com --set '备注=内部 API'
"$POPORTS" release 10176
"$POPORTS" check
"$POPORTS" backup /absolute/path/backup.sqlite3
"$POPORTS" export-csv /absolute/path/export.csv
"$POPORTS" import-csv /absolute/path/additions.csv
```

除 `--output port` 外，成功输出 JSON；失败写 stderr 并返回非零码。更多选项查子命令 `--help`。

## 分配与变更边界

- 端口全局唯一，不按主机或 TCP/UDP 区分。没有业务信息的旧行仍是预留项。
- 自动分配从历史最高登记值之后开始，最低 10001，可用 `--start` 提高起点。释放后也不自动回收旧端口；明确复用需 `--port`。上限 65535。
- 写操作先获取 SQLite 写事务，再读取与分配；端口有主键及范围约束。同机多进程可以并发调用，写入排队，等待超过 10 秒失败。
- `register` 不覆盖旧值；元数据或端口冲突需显式 `update`。使用预留行也通过指定端口的 `update` 完成。释放须由用户明确要求；`release` 只删登记，不停止服务。
- 旧台账可能有同一身份对应多个端口，迁移时保留。遇到歧义，先查询后用 `--port` 选择；新注册或身份更新不会新增这种歧义。
- 登记不是操作系统端口预占。部署前在目标主机检查监听情况；此脚本不启动服务、改 Docker、开放防火墙。

## CSV 与数据保护

兼容 `assets/index.csv` 的 13 列，保留附加列、中文、逗号和多行字段。首次迁移记住表头顺序、BOM 和换行风格；导出按端口排序，保留字段值，不承诺原始字节或引号形式一致。logo／截图仅保留引用，不复制附件目录。

`import-csv` 仅增量加入：相同端口且字段完全一致则跳过，任何端口内容冲突则整次回滚。附加列取并集，已有记录缺失的新列导出为空；更正旧记录使用 `update`，不要靠重复导入覆盖。CSV 导出再迁入新库不保留已释放端口的历史最高值，完整迁移或恢复使用 SQLite `backup`。

数据库、备份及导出文件创建为仅当前用户可读写。导出与备份只写新文件，拒绝覆盖；批量维护前执行 `backup`。查询可能返回备注中的私人信息，报告只展示必要字段，不把真实台账、导出、备份或凭据提交进 Skill 仓库。

仅从单机本地文件系统访问数据库；跨机器通过 SSH 到该机执行 CLI，不通过 SMB／同步盘多机直写。恢复备份前暂停所有写入并明确选择版本。

## 验证

运行 `uv run --no-project python -m unittest discover -s <Skill绝对路径>/tests -v`。测试使用隔离临时台账，覆盖并发注册、幂等、冲突回滚、CSV 兼容性和备份恢复，不触碰用户数据。
