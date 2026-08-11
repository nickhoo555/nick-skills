---
name: maintain-caddy-lan-wan
description: 维护 Caddy 的内外网双入口：caddy-lan 面向内网并提供完整服务，caddy-wan 面向公网并只暴露明确允许的能力；支持用本地 .env 指定两套 Docker Compose 目录。用户提到 caddy-lan、caddy-wan、内外网反向代理或把服务开放到公网时使用。
metadata:
  internal: true
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

配置文件位于本 Skill 目录的 `.env`。首次使用时，从 `.env.example` 复制并填写两套 Compose 的绝对目录；`.gitignore` 已排除 `.env`，用户路径不会进入 Git。

每次维护前：

1. 读取 `.env`；缺失时请用户提供两个目录并创建它。
2. 确认目录存在，且包含 `compose.yaml`、`compose.yml`、`docker-compose.yaml` 或 `docker-compose.yml`。
3. 先读取对应 Compose 文件，再沿挂载关系找到实际 `Caddyfile`；不要猜测配置文件位置。

只把占位配置写入 `.env.example`，把用户的真实路径留在 `.env`。
