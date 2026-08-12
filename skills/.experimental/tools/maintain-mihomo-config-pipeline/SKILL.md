---
name: maintain-mihomo-config-pipeline
description: 维护 Mihomo（Clash）配置管线：由 Web 发布者提供自定义 YAML，YAML 通过 proxy-providers 和 rule-providers 聚合上游，Clash Party、Stash 等订阅者消费该配置，并可选接入 Sub-Store 转换节点。用户提到 Mihomo 配置发布、Clash 订阅、providers 聚合或这些服务的位置配置时使用。
metadata:
  internal: true
---

# Mihomo 配置管线

```text
上游节点 -> [Sub-Store，可选] -> proxy-providers ┐
规则来源 ---------------------> rule-providers ├-> 自定义 YAML -> Web 发布者 -> Clash Party / Stash
```

## 角色

- **发布者**：维护一份自定义 Mihomo YAML，并通过任意静态 Web 服务提供稳定的 HTTP(S) 订阅地址。Web 服务只负责发布，不拥有配置语义。
- **配置**：用多个 `proxy-providers` 聚合上游节点，用多个 `rule-providers` 聚合规则；代理组引用 providers，规则引用 rule sets。
- **订阅者**：Clash Party、Stash 等客户端订阅同一 YAML 地址。分别验证目标客户端，避免把某个客户端的本地状态写回公共配置。
- **转换者（可选）**：Sub-Store 只在上游节点需要清洗或转换时介入；把它视为 provider 的上游，不在本 Skill 展开其配置。

发布者、订阅者、转换者彼此独立；以发布的 YAML 为配置真源。

## 本地配置

配置文件位于本 Skill 目录的 `.env`；`.gitignore` 已排除它。

位置可写成本地绝对路径或 `ssh://主机别名/绝对路径`。未部署或当前不维护的可选服务留空。

每次维护前：

1. 检查 `.env`；缺失时从 `.env.example` 原样复制创建，立即使用其中的默认值尝试连接和定位。已有 `.env` 保持不变。
2. 读取 `.env` 并解析本地或 SSH 位置。必需默认值不可用时，再向用户索取正确位置并更新 `.env`；空白的可选服务直接跳过。
3. 从发布服务配置或挂载关系定位实际 YAML，不猜测静态目录。
4. 检查 YAML 的 providers、代理组和规则引用是否闭合，再用目标 Mihomo 内核校验。
5. 通过发布地址读取 YAML，确认状态码、内容和缓存符合预期。
6. 分别验证已配置的订阅者能够更新；仅在需要转换节点时检查 Sub-Store。

把可公开、可复用的默认值写入 `.env.example`；把用户的覆盖值和含凭据的上游 URL 留在 `.env` 或目标服务的私密配置中。
