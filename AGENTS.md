# Repository maintenance

这个仓库只保存 Nick 自己维护的 Agent Skills。第三方 Skill 从其官方仓库直接安装，不复制到这里。

## Layout

- `skills/.experimental/<skill-name>/SKILL.md`：验证中的 Skill。
- `skills/<skill-name>/SKILL.md`：已经公开的 Skill。
- Skill 的引用资料、脚本和模板与其 `SKILL.md` 放在同一目录。

不要用额外 bucket 表示成熟度；`metadata.internal` 是公开状态的唯一真源。

## Validation status

验证中的 Skill 必须设置：

```yaml
metadata:
  internal: true
```

它不得出现在顶层 `README.md` 的公开目录中。

已公开的 Skill 不得设置 `metadata.internal: true`，并且必须在顶层 `README.md` 中以 Skill 名称链接到它的 `SKILL.md`。

## Promotion workflow

1. 在 `skills/.experimental/<skill-name>/` 创建和验证 Skill。
2. 使用 `INSTALL_INTERNAL_SKILLS=1 npx skills add . --list` 检查内部发现。
3. 验证完成后，将目录移动到 `skills/<skill-name>/`。
4. 删除 `metadata.internal: true`。
5. 将 Skill 添加到顶层 `README.md` 的 **Public skills**。
6. 运行 `bun scripts/check-skills.ts` 和 `npx skills add . --list`。

弃用 Skill 时直接删除，由 Git 历史保留。不要维护 deprecated bucket。

## Invocation

- 只应由用户主动调用的 Skill 设置 `disable-model-invocation: true`。
- 需要模型自动触发的 Skill 保留简洁、触发条件明确的 `description`。

调用方式与公开状态是两个独立维度。

## Verification

每次新增、移动、重命名或修改 frontmatter 后运行：

```bash
bun scripts/check-skills.ts
```

校验器负责检查目录、名称、重复项、公开目录以及 `metadata.internal` 一致性。
