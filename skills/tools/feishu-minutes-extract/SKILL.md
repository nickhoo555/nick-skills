---
name: feishu-minutes-extract
description: 提取飞书妙记 Web 端文字记录的原始接口 JSON、段落、句子、词级时间戳和发言人映射；支持已登录页面和 HAR 离线解析。用于妙记原始文字记录导出，不用于智能纪要或音视频转录。
---

# 飞书妙记原始文字记录

交付三类文件：原始响应 `raw/*.json`、结构化/文本/字幕 `transcript.*`、含 SHA-256 和完整性结果的 `manifest.json`。原始指接口当前返回的文字记录（可能已被用户编辑），不是历史 ASR 版本或录音的重新转录。

## 选路线

1. 确认用户指定的妙记 URL、页面标题和当前查看权限。只处理该会议，保留登录态在浏览器内。
2. **已有 HAR**：直接运行离线 CLI。**已登录网页**：读取 [浏览器采集流程](references/browser-workflow.md)，通过可用的网络检查工具或 Chrome DevTools 导出已清理 HAR。**用户自行执行脚本**：提供 `scripts/browser-export.js`，在同一妙记页面内发起只读同源 GET 并下载 capture 文件。
3. 按下面命令导出到新的目录。只有 `manifest.completeness.complete=true` 才能称为完整提取；报告实际段落数。部分捕获须补齐，或在用户明确接受部分结果时使用 `--allow-partial`。

## 运行

下列命令以本 Skill 文件夹为工作目录。Node >=22.18 直接运行 TypeScript，无依赖、无需安装 npm 包。

```sh
# HAR 模式：--url 用来隔离会议与租户，--out 必须是不存在的新目录
node scripts/cli.ts --har /absolute/path/meeting.har \
  --url 'https://YOUR-TENANT.feishu.cn/minutes/OBJECT_TOKEN' \
  --out /absolute/path/new-export --title '会议标题'

# 浏览器脚本下载的 capture
node scripts/cli.ts --capture /absolute/path/OBJECT_TOKEN.capture.json \
  --out /absolute/path/new-export
```

## 可靠性与边界

- 完整性基于从第 0 页至 `has_more=false` 的全部段落索引、正文覆盖和发言人映射，不以可见 DOM、单次响应或时间轴是否从 0 开始判断。字幕批次的 `has_more` 不是全局完整性证据。
- `raw` 保留 HTTP 解压后响应的原始 UTF-8 正文，不重新序列化；未知字段也在其中。结构化结果按 `contents.content` 直接连接，保留内容自带空格与标点。大整数 ID 保持字符串，避免 JavaScript 精度丢失。
- 401/403、业务错误、结构漂移或抓取期间版本变化时停止；不重试探测权限、不改分享设置。只读提取不涉及 Cookie 导出、浏览器用户目录或外部上传。网络 HAR 本身仍含会议内容，按私有资料保管。
- 浏览器工具仅提供只读 DOM evaluation 时，走网络工具或 DevTools UI 的 HAR 路线；不把网络 fetch、隐藏状态读取或下载副作用塞进该 evaluation。
- 接口是未公开的 Web 内部实现。维护时先查看实际 Network 响应，再读 [接口证据与数据结构](references/web-api.md) 更新适配器；不要凭空猜端点或把失败降级成空文本成功。

开发入口：`scripts/core.ts` 是离线解析与校验，`scripts/capture.ts` 通过注入 transport 采集，`scripts/cli.ts` 是文件 IO 组合根。修改浏览器采集器后运行 `node scripts/build-browser.ts`；验证用 `node --test tests/*.test.ts`（也可 `pnpm run test`）。测试仅含合成数据。
