---
name: setup-node
description: 配置 Node 与 pnpm 环境基线。用于新开发机或服务器设置公共镜像、私有 Registry 路由、pnpm 11 新包冷静期、构建脚本审批，以及处理特定包的安装兼容问题。
---

# 配置 Node 环境

## 快速开始

### 安装

```bash
# 设置代理：按需替换 127.0.0.1:7890
export proxy_host_and_port=127.0.0.1:7890
export http_proxy="http://${proxy_host_and_port}" https_proxy="http://${proxy_host_and_port}" all_proxy="http://${proxy_host_and_port}" HTTP_PROXY="http://${proxy_host_and_port}" HTTPS_PROXY="http://${proxy_host_and_port}" ALL_PROXY="http://${proxy_host_and_port}"
curl google.com # 有响应（如 301）证明成功

# 安装 fnm
curl -fsSL https://fnm.vercel.app/install | bash
# 安装最新 LTS，并立即启用
fnm install --lts --use
# 设置为以后新终端默认使用的版本
fnm default lts-latest

# 安装 pnpm
wget -qO- https://get.pnpm.io/install.sh | sh -

# 验证
fnm current
node -v
npm -v
pnpm -v
```

### 配置

```bash
# 取消代理，防止代理干扰自建 Registry 的连接
unset proxy_host_and_port http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY

# 公共包走淘宝镜像
npm config set registry "https://registry.npmmirror.com/" --location=user
# 内部包走自建 Registry
npm config set "@starx:registry" "https://npm.lan.starxmate.com/" --location=user

# pnpm 11：内部包不受 24 小时冷静期限制
pnpm config set --global --json minimumReleaseAgeExclude '["@starx/*"]'

# 验证
npm config get registry
npm config get "@starx:registry"
pnpm config get --json minimumReleaseAgeExclude
```

预期：

```text
https://registry.npmmirror.com/
https://npm.lan.starxmate.com/
["@starx/*"]
```

Registry 和认证写入用户 `.npmrc`；pnpm 11 的其他全局设置写入 `pnpm config get globalconfig` 返回的 YAML 文件。

## pnpm 11 构建审批

全局安装可能出现 `Choose which packages to build`。这是安装脚本审批，不是 Registry 错误。检查包名后用空格选择；完全信任依赖树时按 `a` 全选，再按回车确认。

## hihi 的 ONNX 安装

当前 `self-host` 有 NVIDIA 驱动，但没有 CUDA Runtime。安装 `@starx/hihi` 时跳过 ONNX CUDA provider 下载：

```bash
export ONNXRUNTIME_NODE_INSTALL=skip
pnpm add -g @starx/hihi
```

CPU 版仍可使用。将来安装 CUDA Runtime 后移除此变量，并确认 `onnxruntime-node` 已修复 NuGet 中国区 302 跳转。
