---
name: maintain-caddy-lan-wan
description: 维护 Caddy 的内外网双入口：caddy-lan 面向内网并提供完整服务，caddy-wan 面向公网并只暴露明确允许的能力；支持用本地 .env 指定两套 Docker Compose 目录。用户提到 caddy-lan、caddy-wan、内外网反向代理或把服务开放到公网时使用。
---

# Caddy 内外网双入口

```text
内网客户端  -> caddy-lan -> 后端服务
公网客户端  -> caddy-wan -> 后端服务
```

- `caddy-lan` 是内网完整入口，服务受信任设备。
- `caddy-wan` 是公网安全边界，默认拒绝，只放行必要的域名、路径和方法。
- 两者可以代理同一后端，但配置彼此独立；公网开放不等于复制内网配置。

修改配置时，先判断请求来自内网还是公网；公网需求始终采用最小暴露面。

## 本地配置

配置文件位于本 Skill 目录的 `.env`；`.gitignore` 已排除它。位置可写成本地绝对路径或 `ssh 主机别名:/绝对路径`。

每次维护前：

1. 检查 `.env`；缺失时从 `.env.example` 原样复制创建，立即使用其中的默认值尝试连接和定位。已有 `.env` 保持不变。
2. 读取 `.env` 并解析本地或 SSH 位置。默认值不可用时，再向用户索取正确位置并更新 `.env`。
3. 确认位置包含 `compose.yaml`、`compose.yml`、`docker-compose.yaml` 或 `docker-compose.yml`。
4. 先读取对应 Compose 文件，再沿挂载关系找到实际 `Caddyfile`；不要猜测配置文件位置。

把可公开、可复用的默认值写入 `.env.example`，把用户的覆盖值留在 `.env`。
