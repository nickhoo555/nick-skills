import { createHash } from 'node:crypto';

export type RawResponse = { url: string; status: number; body: string; captured_at?: string };
export type Capture = {
  format: 'feishu-minutes-capture/v1';
  source_url: string;
  title?: string;
  captured_at?: string;
  responses: RawResponse[];
};
type ObjectMap = Record<string, any>;
const endpoints = new Set([
  '/minutes/api/subtitles/paragraph-ids',
  '/minutes/api/speakers',
  '/minutes/api/subtitles_v2',
]);
const queryKeys = new Set([
  'object_token', 'language', 'page_size', 'page_num', 'size', 'paragraph_id',
  'translate_lang', 'is_fluent', 'filter_speaker', 'forward',
]);

export function parseSource(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.feishu.cn') ||
      url.username || url.password || url.port) {
    throw new Error('仅支持 https://<租户>.feishu.cn/minutes/<token>，不接受认证信息或自定义端口');
  }
  const match = /^\/minutes\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
  if (!match || match[1] === 'api') throw new Error('URL 必须指向单个飞书妙记');
  return { origin: url.origin, token: match[1], url: `${url.origin}/minutes/${match[1]}` };
}

/** Keep integer identifiers lossless without rewriting strings or decimal/exponent numbers. */
export function parseLossless(text: string): any {
  const safe = text.replace(/"(?:\\[\s\S]|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => {
    if (/^-?\d+$/.test(token)) {
      const n = BigInt(token);
      if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER)) {
        return JSON.stringify(token);
      }
    }
    return token;
  });
  // Validate the original as well: quoting an oversized invalid numeric literal must not make it valid.
  JSON.parse(text);
  return JSON.parse(safe);
}

function object(value: any, label: string): ObjectMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`缺少对象：${label}`);
  return value;
}
function array(value: any, label: string): any[] {
  if (!Array.isArray(value)) throw new Error(`缺少数组：${label}`);
  return value;
}
function id(value: any, label: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  throw new Error(`无效或已丢失精度的 ID：${label}`);
}
function millis(value: any, label: string): number {
  if (value === '' || value === null || value === undefined) throw new Error(`缺少时间：${label}`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`无效的毫秒时间：${label}`);
  return n;
}
function interval(item: ObjectMap, label: string) {
  const start_ms = millis(item.start_time, `${label}.start_time`);
  const end_ms = millis(item.stop_time, `${label}.stop_time`);
  if (end_ms < start_ms) throw new Error(`结束时间早于开始时间：${label}`);
  return { start_ms, end_ms };
}
function flag(value: any, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`缺少布尔值：${label}`);
  return value;
}
function nonnegativeInt(value: any, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`无效整数：${label}`);
  return value;
}
export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export function safeResponseUrl(value: string): string {
  const u = new URL(value);
  for (const key of [...u.searchParams.keys()]) if (!queryKeys.has(key)) u.searchParams.delete(key);
  u.hash = '';
  u.username = '';
  u.password = '';
  return u.toString();
}

function relevant(value: string, source: ReturnType<typeof parseSource>): URL | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.origin !== source.origin || !endpoints.has(url.pathname) ||
      url.searchParams.get('object_token') !== source.token) return undefined;
  // Translation / fluent text is not the source transcript requested here.
  if (url.pathname === '/minutes/api/subtitles_v2' &&
      (url.searchParams.get('translate_lang') !== 'default' || url.searchParams.get('is_fluent') !== 'false')) return undefined;
  return url;
}

export function fromHar(har: any, sourceUrl: string): Capture {
  const source = parseSource(sourceUrl);
  const entries = array(har?.log?.entries, 'HAR.log.entries');
  const responses: RawResponse[] = [];
  for (const entry of entries) {
    if (!relevant(entry?.request?.url, source)) continue;
    if (entry.request.method !== 'GET') throw new Error('目标接口出现非 GET 请求，停止解析');
    const content = entry.response?.content;
    if (typeof content?.text !== 'string') throw new Error('HAR 缺少目标接口响应正文；请导出带内容的 HAR');
    if (content.encoding && content.encoding !== 'base64') throw new Error(`不支持的 HAR 编码：${content.encoding}`);
    const body = content.encoding === 'base64'
      ? new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(content.text, 'base64'))
      : content.text;
    responses.push({ url: safeResponseUrl(entry.request.url), status: entry.response.status, body,
      captured_at: entry.startedDateTime });
  }
  if (!responses.length) throw new Error('没有找到本妙记的原文接口响应；检查 URL、HAR 正文与原文模式');
  return { format: 'feishu-minutes-capture/v1', source_url: source.url, responses };
}

function dataOf(response: RawResponse) {
  if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}：${new URL(response.url).pathname}；停止，检查登录和查看权限`);
  }
  if (typeof response.body !== 'string') throw new Error('捕获文件必须保留 body 原始字符串');
  let result;
  try { result = parseLossless(response.body); } catch { throw new Error('响应不是合法 JSON，可能已跳转登录页'); }
  if (result?.code !== 0) throw new Error(`飞书业务错误 code=${String(result?.code)}；停止，检查登录和权限`);
  return object(result.data, 'response.data');
}

export function extract(capture: Capture, options: { allowPartial?: boolean; title?: string } = {}) {
  if (capture?.format !== 'feishu-minutes-capture/v1') throw new Error('不支持的 capture 格式');
  const source = parseSource(capture.source_url);
  const responses: RawResponse[] = [];
  const seenRaw = new Set<string>();
  const indexPages = new Map<number, { list: ObjectMap[]; has_more: boolean }>();
  const index = new Map<string, ObjectMap>();
  const paragraphs = new Map<string, ObjectMap>();
  const paragraphSpeakers = new Map<string, string>();
  const speakerNames = new Map<string, string>();
  const versions = new Set<string>();
  const totals = new Set<number>();
  let speakersComplete = false;
  let speakersSeen = false;

  for (const response of array(capture.responses, 'capture.responses')) {
    const u = relevant(response?.url, source);
    if (!u) throw new Error('capture 含跨会议、跨站点、非白名单或非原文响应');
    const data = dataOf(response);
    const safe = { ...response, url: safeResponseUrl(response.url) };
    const digest = sha256(`${safe.url}\n${response.body}`);
    if (!seenRaw.has(digest)) { responses.push(safe); seenRaw.add(digest); }
    if (u.pathname.endsWith('/paragraph-ids')) {
      const pageString = u.searchParams.get('page_num');
      if (pageString === null || !/^\d+$/.test(pageString)) throw new Error('索引请求缺少 page_num');
      const page = nonnegativeInt(Number(pageString), 'page_num');
      const value = { list: array(data.list, 'index.list'), has_more: flag(data.has_more, 'index.has_more') };
      const existing = indexPages.get(page);
      if (existing && JSON.stringify(existing) !== JSON.stringify(value)) throw new Error('索引在捕获期间变化；请重新完整捕获');
      indexPages.set(page, value);
    } else if (u.pathname.endsWith('/speakers')) {
      const more = flag(data.has_more, 'speakers.has_more');
      speakersSeen = true;
      speakersComplete ||= !more;
      for (const [pid, sid] of Object.entries(object(data.paragraph_to_speaker, 'paragraph_to_speaker'))) {
        const speaker = id(sid, 'speaker mapping');
        if (paragraphSpeakers.has(pid) && paragraphSpeakers.get(pid) !== speaker) throw new Error('发言人映射变化；请重新捕获');
        paragraphSpeakers.set(pid, speaker);
      }
      for (const [sid, info] of Object.entries(object(data.speaker_info_map, 'speaker_info_map'))) {
        const name = object(info, 'speaker').user_name;
        if (typeof name !== 'string') throw new Error('发言人缺少 user_name');
        if (speakerNames.has(sid) && speakerNames.get(sid) !== name) throw new Error('发言人名称变化；请重新捕获');
        speakerNames.set(sid, name);
      }
    } else {
      if (data.translate_lang !== 'default') throw new Error('字幕响应不是源语言');
      if (data.version !== undefined) versions.add(String(data.version));
      if (data.last_edit_version !== undefined) versions.add(`edit:${data.last_edit_version}`);
      totals.add(nonnegativeInt(data.total, 'subtitles.total'));
      flag(data.has_more, 'subtitles.has_more');
      for (const p of array(data.paragraphs, 'subtitles.paragraphs')) {
        object(p, 'paragraph');
        const pid = id(p.pid, 'paragraph.pid');
        const existing = paragraphs.get(pid);
        if (existing && JSON.stringify(existing) !== JSON.stringify(p)) throw new Error(`段落 ${pid} 在捕获期间变化；请重新捕获`);
        paragraphs.set(pid, p);
      }
    }
  }
  const sortedPages = [...indexPages.keys()].sort((a, b) => a - b);
  for (const page of sortedPages) {
    for (const p of indexPages.get(page)!.list) {
      object(p, 'index paragraph');
      const pid = id(p.pid, 'index.pid');
      if (index.has(pid)) throw new Error(`索引出现重复段落 ${pid}`);
      interval(p, 'index');
      index.set(pid, p);
    }
  }
  const indexComplete = sortedPages.length > 0 && sortedPages.every((page, i) => page === i &&
    indexPages.get(page)!.has_more === (i < sortedPages.length - 1));
  if ([...versions].filter(x => !x.startsWith('edit:')).length > 1 ||
      [...versions].filter(x => x.startsWith('edit:')).length > 1 || totals.size > 1) {
    throw new Error('字幕版本或总数不一致；请在会议编辑结束后重新完整捕获');
  }
  const missing = [...index.keys()].filter(pid => !paragraphs.has(pid));
  const extra = [...paragraphs.keys()].filter(pid => !index.has(pid));
  const unmapped = [...paragraphs.keys()].filter(pid => !paragraphSpeakers.has(pid) ||
    !speakerNames.has(paragraphSpeakers.get(pid)!));
  const expectedTotal = [...totals][0];
  const totalMatches = expectedTotal !== undefined && expectedTotal === index.size;
  const issues: string[] = [];
  if (!indexComplete) issues.push('段落索引未完整捕获（必须从 page_num=0 连续到 has_more=false）');
  if (!speakersSeen || !speakersComplete) issues.push('发言人响应不完整');
  if (!totalMatches) issues.push('字幕 total 与完整索引数量不一致或缺失');
  if (missing.length) issues.push(`缺少 ${missing.length} 段正文`);
  if (extra.length) issues.push(`${extra.length} 段不在索引内`);
  if (unmapped.length) issues.push(`${unmapped.length} 段缺少发言人映射或名称`);
  if (!paragraphs.size) issues.push('未捕获任何段落正文');
  if (issues.length && !options.allowPartial) throw new Error(`完整性检查失败：${issues.join('；')}。补全响应，或明确使用 --allow-partial 标记为不完整导出`);

  const ordered = [...index.keys()].filter(pid => paragraphs.has(pid));
  ordered.push(...extra.sort((a, b) => Number(paragraphs.get(a)!.start_time) - Number(paragraphs.get(b)!.start_time)));
  const normalized = ordered.map(pid => {
    const p = paragraphs.get(pid)!;
    const timing = interval(p, `paragraph:${pid}`);
    const i = index.get(pid);
    if (i && (String(i.start_time) !== String(p.start_time) || String(i.stop_time) !== String(p.stop_time))) {
      throw new Error(`段落 ${pid} 时间与索引不一致；请重新捕获`);
    }
    const sentences = array(p.sentences, 'paragraph.sentences').map(s => {
      object(s, 'sentence');
      const tokens = array(s.contents, 'sentence.contents').map(c => {
        object(c, 'content');
        if (typeof c.content !== 'string') throw new Error('content.content 必须是原始字符串');
        return { id: id(c.cid, 'cid'), ...interval(c, 'content'), language: c.language ?? null, text: c.content };
      });
      return { id: id(s.sid, 'sid'), ...interval(s, 'sentence'), language: s.language ?? null,
        text: tokens.map(c => c.text).join(''), tokens };
    });
    const speakerId = paragraphSpeakers.get(pid) ?? null;
    return { id: pid, ...timing, paragraph_type: p.paragraph_type ?? null,
      speaker_id: speakerId, speaker: speakerId === null ? null : speakerNames.get(speakerId) ?? null,
      text: sentences.map(s => s.text).join(''), sentences };
  });
  const completeness = { complete: issues.length === 0, index_complete: indexComplete,
    speakers_complete: speakersComplete, expected_paragraphs: indexComplete ? index.size : null,
    declared_total: expectedTotal ?? null, extracted_paragraphs: paragraphs.size,
    missing_paragraph_ids: missing, extra_paragraph_ids: extra, unmapped_paragraph_ids: unmapped, issues };
  const transcript = { schema: 'feishu-minutes-transcript/v1', source_url: source.url,
    title: options.title ?? capture.title ?? source.token,
    text_policy: '按 contents.content 顺序直接连接；不加空格、不润色、不去除停顿或标点',
    time_unit: 'milliseconds', completeness,
    counts: { paragraphs: normalized.length, sentences: normalized.reduce((n, p) => n + p.sentences.length, 0),
      tokens: normalized.reduce((n, p) => n + p.sentences.reduce((m, s) => m + s.tokens.length, 0), 0),
      speakers: new Set(normalized.map(p => p.speaker_id).filter(Boolean)).size },
    paragraphs: normalized };
  return { transcript, responses, completeness };
}

export function timecode(ms: number, srt = false) {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor(ms / 60000) % 60;
  const seconds = Math.floor(ms / 1000) % 60;
  const base = [hours, minutes, seconds].map(n => String(n).padStart(2, '0')).join(':');
  return `${base}${srt ? ',' : '.'}${String(ms % 1000).padStart(3, '0')}`;
}
export function renderText(transcript: ReturnType<typeof extract>['transcript']) {
  const warning = transcript.completeness.complete ? '' : '【不完整导出】\n';
  return warning + transcript.paragraphs.map(p =>
    `[${timecode(p.start_ms)} → ${timecode(p.end_ms)}] ${p.speaker ?? '未知发言人'}\n${p.text}`).join('\n\n') + '\n';
}
export function renderSrt(transcript: ReturnType<typeof extract>['transcript']) {
  // Sentence-level cues are more readable than 1–2 minute paragraph-level cues.
  const cues = transcript.paragraphs.flatMap(p => p.sentences.map(s => ({ ...s, speaker: p.speaker })))
    .sort((a, b) => a.start_ms - b.start_ms);
  return cues.map((s, i) =>
    `${i + 1}\n${timecode(s.start_ms, true)} --> ${timecode(s.end_ms, true)}\n${s.speaker ?? '未知发言人'}: ${s.text}\n`).join('\n');
}
