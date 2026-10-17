# Web 接口证据与结构

## 已验证范围

2026-10-17，通过用户提供的已登录飞书妙记详情页的 Chrome DevTools Network 导出 HAR，观察以下三个 **GET** 接口。它们不是飞书开放平台的稳定公共 API；不需要申请应用密钥，但须有当前用户的页面查看权限。其他租户、域名和旧版 `subtitles` 未验证。

| 路径 | 真实观察到的特有查询参数 | 核心字段 |
|---|---|---|
| `/minutes/api/subtitles/paragraph-ids` | `page_size=10000&page_num=0` | `data.list[]: {pid,start_time,stop_time}`、`has_more` |
| `/minutes/api/speakers` | `size=10000&translate_lang=default` | `paragraph_to_speaker`、`speaker_info_map`、`has_more`、`total` |
| `/minutes/api/subtitles_v2` | `paragraph_id=<首段pid>&size=117&translate_lang=default&is_fluent=false&filter_speaker=true` | `paragraphs[]`、`total`、`has_more`、`version`、`last_edit_version` |

三者共有 `object_token=<URL中的token>&language=zh_cn`，业务 envelope 为 `{code:0,msg:"success",data:{...}}`。实际样本：117 段、470 句、7320 个 content token，索引与正文全部覆盖。时间单位为毫秒，常以十进制字符串返回。

## 段落与发言人是两份数据

```text
subtitles_v2.data.paragraphs[]
  pid, start_time, stop_time, paragraph_type
  sentences[]
    sid, start_time, stop_time, language, origin_length
    contents[]
      cid, start_time, stop_time, language, content

speakers.data.paragraph_to_speaker[pid] -> speaker_id
speakers.data.speaker_info_map[speaker_id].user_name -> 发言人名称
```

段落自身没有发言人字段。`speakers.total` 在样本中是段落数量，不是发言人数。网页侧边栏的人数可能不包含临时「说话人 N」；保留接口真实映射，不强行按侧边栏数量合并身份。

`pid/sid/cid/user_id` 和映射键是字符串，但 `speaker_info_map` 的 `origin_user_id`、`tenant_id` 等还有未加引号的 64 位整数。直接 `JSON.parse` 后重新保存整个响应会丢精度。代码将原始正文独立原样保存；离线解析使用词法保护将安全整数范围外的整数字面量转为字符串。浏览器采集器只从解析后的数据读取字符串索引 ID，原始正文仍作为字符串装入 capture。

## 完整性判据

- 索引从 `page_num=0` 连续到最后一页 `has_more=false`，无重复 pid。
- `subtitles.total` 与索引段数一致，所有 pid 都有正文，没有外来 pid。
- 所有段落均能映射到发言人及其名称，完整的 speakers 响应 `has_more=false`。
- 同一 pid 的重复响应内容一致；版本、编辑版本和总数在捕获期间没有变化；正文与索引时间一致。
- 空白时间不等于丢段。只证明当前服务端文字记录索引的覆盖，不证明 ASR 没有漏听，也不恢复用户删掉的历史文字。

## 可覆盖适配点

`core.ts` 处理 HAR / capture 和数据校验，CLI 负责本地 IO；`captureMinutes(options, transport)` 的 transport 可注入。浏览器构建器把同一 TypeScript 采集逻辑转为自包含脚本，避免维护两份业务实现。可覆盖批量大小和超时；接口漂移应依据新响应修改适配器和测试，不猜测 speakers 分页或绕过访问限制。

`subtitles_v2` 使用索引中每批首 pid 与该批 size 请求；跨页索引与小批量行为是基于已观察参数的实现推导，并由覆盖检查兜底。采集器若不能取齐该批应停止，不凭 `has_more=false` 当作全文。

## 文件语义

- `raw/*.json`：HTTP 解压后的 UTF-8 响应正文原样落盘，包括服务端未知字段；不是压缩后的网络包。
- `transcript.json`：字符串 ID、毫秒时间、发言人、段落/句子/token 层次，显式完整性状态。
- `transcript.txt`：段落时间范围与发言人，词文本按原顺序直接连接。
- `transcript.srt`：句级时间轴，按起始时间排序；重叠讲话保留重叠时间，不改写正文。
- `manifest.json`：最后写入的完成标志，含范围、计数、完整性、每个原始响应的路径、请求 URL（白名单参数）、HTTP 状态、字节数和 SHA-256。

原始响应可能含头像 URL、组织名、内部标识和会议原文。保持本地私有；可复用包及合成测试不携带真实会议数据或会话凭据。
