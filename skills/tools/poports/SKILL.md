---
name: poports
description: 登记、分配、查询、释放服务端口及备份台账时使用；提供幂等 CLI，支持 CSV 导入导出。
---

# poports

用本 Skill 下 `scripts/poports` 的绝对路径作为 `$POPORTS`；已加入 PATH 时可直接用 `poports`。

```bash
PORT=$("$POPORTS" register my-service --app web --host my-host --output port)
"$POPORTS" list --service my-service
"$POPORTS" get 10175
"$POPORTS" update 10175 --set '备注=内部服务'
"$POPORTS" release 10175  # 用户明确要求释放时使用
"$POPORTS" backup
"$POPORTS" check
```

`服务 + 应用 + 主机` 相同则返回原端口；多入口用不同 `--app`。登记不等于实际占用端口。
除 `--output port` 外输出 JSON，失败返回非零码；更多参数用 `<子命令> --help` 查询。

## 按需读取

- 首次接入、切换数据库或 CSV 导入导出：[接入与数据交换](references/operations.md#接入与数据交换)。
- 分配冲突、预留项、批量修改或部署检查：[登记与变更规则](references/operations.md#登记与变更规则)。
- 定时备份、淘汰或恢复：[备份操作](references/backups.md)。
- 修改 Skill 或脚本时：[开发验证](references/operations.md#开发验证)。
