---
name: use-starx-npm
description: 使用 Starx 团队内网 npm 仓库。用于匿名安装、注册或登录账户、修改密码、发布 @starx 包、配置 CI token 和说明仓库权限。
---

# 使用 Starx npm

按用户问题只给相关部分；需要完整指南时给出以下内容。

## 基本信息

- Registry：`https://npm.lan.starxmate.com/`
- 私有 scope：`@starx/*`
- 内网允许匿名安装；注册、发布和改密码需认证。

若机器尚未配置公共源、Starx scope 和 pnpm 11 基线，先使用 `$setup-node`。

## 安装

项目 `.npmrc`：

```ini
@starx:registry=https://npm.lan.starxmate.com/
```

无需登录即可执行：

```bash
pnpm add @starx/<package>
# 或 npm install @starx/<package>

# 全局安装
pnpm add -g @starx/<package>
```

## 账户

```bash
# 新用户注册
npm adduser --auth-type=legacy --registry=https://npm.lan.starxmate.com/

# 已有用户登录
npm login --auth-type=legacy --registry=https://npm.lan.starxmate.com/

# 自助修改密码
npm profile set password --registry=https://npm.lan.starxmate.com/
```

## 发布

包名必须使用 `@starx/*`，并在 `package.json` 固定发布地址：

```json
{
  "name": "@starx/example",
  "publishConfig": {
    "registry": "https://npm.lan.starxmate.com/"
  }
}
```

登录后执行：

```bash
pnpm publish
# 或 npm publish
```

## CI

将个人或 CI 专用账户登录后生成的 token 保存为 CI Secret `NPM_TOKEN`，工作区 `.npmrc` 使用：

```ini
@starx:registry=https://npm.lan.starxmate.com/
//npm.lan.starxmate.com/:_authToken=${NPM_TOKEN}
```

使用 CI 专用账户；不提交真实 token。

## 权限

- 所有人可匿名安装。
- 登录用户可发布 `@starx/*`。
- 只有 `starx-admin` 可删除版本。
- 非 `@starx` 包不能发布到此仓库。
