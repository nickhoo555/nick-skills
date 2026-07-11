# Nick's Skills

我维护和验证自己使用的 Agent Skills。第三方 Skill 不复制进本仓库；例如 Matt Pocock 的 Skill 继续直接从官方仓库安装：

```bash
npx skills add mattpocock/skills
```

## 安装

查看本仓库已经公开的 Skill：

```bash
npx skills add nickhoo555/nick-skills --list
```

安装某个公开 Skill：

```bash
npx skills add nickhoo555/nick-skills --skill <skill-name>
```

## Skill 状态

- **验证中**：位于 `skills/.experimental/<skill-name>/`，并设置 `metadata.internal: true`。
- **已公开**：位于 `skills/<skill-name>/`，不设置 `metadata.internal`，并列入下方目录。

目录用于方便维护，`metadata.internal` 才是 `npx skills` 可见性的依据。

查看或安装验证中的 Skill 时，需要显式开启内部 Skill：

```bash
INSTALL_INTERNAL_SKILLS=1 npx skills add . --list
```

## Public skills

暂无。

## 维护

新增 Skill 时先进入验证阶段：

```text
skills/.experimental/<skill-name>/SKILL.md
```

验证完成后：

1. 移动到 `skills/<skill-name>/SKILL.md`。
2. 删除 `metadata.internal: true`。
3. 在 **Public skills** 中添加指向 `SKILL.md` 的链接。
4. 运行校验：

```bash
bun scripts/check-skills.ts
```

详细规则见 [`AGENTS.md`](./AGENTS.md)。
