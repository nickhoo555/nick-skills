# Nick's Skills

> **105°C 的 Skills** 
> 蒸馏世界，蒸馏自己；
> 你中有我，我中有你；
> 世界之中有你我，你我之中有世界。

## 安装

```bash
npx skills add nickhoo555/nick-skills
```

查看本仓库已经公开的 Skill：

```bash
npx skills add nickhoo555/nick-skills --list
```

安装某个公开 Skill：

```bash
npx skills add nickhoo555/nick-skills --skill <skill-name>
```

## Skill 状态

- **验证中**：位于 `skills/.experimental/<category>/<skill-name>/`，并设置 `metadata.internal: true`。
- **已公开**：位于 `skills/<category>/<skill-name>/`，不设置 `metadata.internal`，并列入下方目录。

`category` 只表示主题分类；`metadata.internal` 才是 `npx skills` 可见性的依据。

查看或安装验证中的 Skill 时，需要显式开启内部 Skill：

```bash
INSTALL_INTERNAL_SKILLS=1 npx skills add . --list
```

## Public skills

### Meta（元知识）

- [`world-foundation-theories`](./skills/meta/world-foundation-theories/SKILL.md)：用底层理论和跨领域认知框架分析复杂问题。

### Tools（工具）

- [`macos-disk-space-governor`](./skills/tools/macos-disk-space-governor/SKILL.md)：为 macOS 内置磁盘建立可持续的审计、归档、迁移和清理方案。

## 维护

新增 Skill 时先进入验证阶段：

```text
skills/.experimental/<category>/<skill-name>/SKILL.md
```

验证完成后：

1. 移动到 `skills/<category>/<skill-name>/SKILL.md`。
2. 删除 `metadata.internal: true`。
3. 在 **Public skills** 中添加指向 `SKILL.md` 的链接。
4. 将 Skill 添加到 `.claude-plugin/marketplace.json` 中与目录 `category` 同名的分组。
5. 运行校验：

```bash
bun scripts/check-skills.ts
npx skills add . --list
```

详细规则见 [`AGENTS.md`](./AGENTS.md)。
