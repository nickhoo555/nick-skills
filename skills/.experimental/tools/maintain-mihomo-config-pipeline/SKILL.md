---
name: maintain-mihomo-config-pipeline
description: 维护 Mihomo（Clash）配置管线：管理以 index.yaml 为入口、可含 proxies 和 rules 子目录的配置目录，通过 providers 聚合上游并供 Clash Party、Stash 等客户端订阅，可选接入 Sub-Store 转换节点。用户提到 Mihomo 配置发布、Clash 订阅或 providers 聚合时使用。
metadata:
  internal: true
---

# Mihomo 配置管线

```text
上游节点 -> [Sub-Store，可选] -> proxy-providers ┐
规则来源 ---------------------> rule-providers ├-> 自定义 YAML -> Web 发布者 -> Clash Party / Stash
```

## 角色

- **发布者**：维护自定义 Mihomo 配置目录；`index.yaml` 是订阅入口，`proxies/` 和 `rules/` 是可选的自定义子配置目录。Web 承载属于外部基础设施，本 Skill 的边界止于目录内容。
- **配置**：用多个 `proxy-providers` 聚合上游节点，用多个 `rule-providers` 聚合规则；代理组引用 providers，规则引用 rule sets。
- **订阅者**：Clash Party、Stash 等客户端订阅同一 YAML 地址。分别验证目标客户端，避免把某个客户端的本地状态写回公共配置。
- **转换者（可选）**：Sub-Store 只在上游节点需要清洗或转换时介入；把它视为 provider 的上游，不在本 Skill 展开其配置。

发布者、订阅者、转换者彼此独立；以发布的 YAML 为配置真源。

## 本地配置

本地配置位于本 Skill 目录的 `.env`；`.gitignore` 已排除它。只配置：

- Mihomo 配置发布者的位置，以及订阅者访问 `index.yaml` 的 HTTP(S) URL；
- 订阅组：本机订阅者及其配置目录；
- 可选的 Sub-Store 位置及其 Web HTTP(S) URL。

Mihomo 配置目录结构：

```text
<MIHOMO_CONFIG_PUBLISHER_LOCATION>/
├── index.yaml
├── proxies/    # 可选
└── rules/      # 可选
```

位置可写成本地绝对路径或 `ssh://主机别名/绝对路径`。URL 必须是可访问的 `http://` 或 `https://` 地址。

`LOCAL_SUBSCRIBER` 只取以下值：

- `docker`：本机 Docker 中运行的 Mihomo；
- `clash-party`：本机 Clash Party。

`LOCAL_SUBSCRIBER_CONFIG_DIR` 是所选本机订阅者的配置目录。不使用 Sub-Store 时将它的位置和 URL 都留空。

每次维护前：

1. 检查 `.env`；缺失时从 `.env.example` 原样复制创建，立即使用其中的默认值尝试连接和定位。已有 `.env` 保持不变。
2. 读取 `.env` 并解析本地或 SSH 位置。默认配置发布者不可用时，再向用户索取正确位置并更新 `.env`。
3. 确认目录包含 `index.yaml`；按需读取已存在的 `proxies/` 和 `rules/`，不要求创建可选目录。
4. 检查 `index.yaml` 的 providers、代理组和规则引用是否闭合，再用目标 Mihomo 内核校验。
5. 请求 `MIHOMO_CONFIG_PUBLISHER_URL`，确认它返回同一份 `index.yaml`。
6. 确认 `LOCAL_SUBSCRIBER` 是 `docker` 或 `clash-party`，并检查 `LOCAL_SUBSCRIBER_CONFIG_DIR` 中的订阅配置。
7. 仅在 `SUB_STORE_LOCATION` 或 `SUB_STORE_URL` 非空且节点需要转换时检查 Sub-Store；配置一项时要求另一项也存在。

把可公开、可复用的默认位置写入 `.env.example`；把用户的覆盖值留在 `.env`。
