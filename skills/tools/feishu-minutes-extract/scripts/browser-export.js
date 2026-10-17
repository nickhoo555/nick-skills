/* Generated from capture.ts. Read-only same-origin GETs, one local JSON download. */
(async () => {





/** Browser transport is injected for deterministic fixture replay; no CDP or cookie access. */
async function captureMinutes(options         , transport            )                   {
  const source = new URL(options.sourceUrl);
  const match = /^\/minutes\/([A-Za-z0-9_-]+)\/?$/.exec(source.pathname);
  if (source.protocol !== 'https:' || !source.hostname.endsWith('.feishu.cn') || source.username ||
      source.password || source.port || !match || match[1] === 'api') throw new Error('请在有查看权限的飞书妙记详情页运行');
  const sourceUrl = `${source.origin}/minutes/${match[1]}`;
  const batchSize = options.batchSize ?? 100;
  const maxPages = options.maxIndexPages ?? 100;
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000 ||
      !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('无效的批量、页数或超时参数');
  const request            = transport ?? ((url, signal) => fetch(url, {
    method: 'GET', credentials: 'same-origin', redirect: 'error',
    headers: { Accept: 'application/json' }, signal,
  }));
  const responses                = [];
  async function get(path        , query                        ) {
    const url = new URL(`/minutes/api/${path}`, source.origin);
    url.search = new URLSearchParams({ ...query, object_token: match [1], language: 'zh_cn' }).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await request(url.toString(), controller.signal);
      if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}：${path}；请检查登录和查看权限`);
      const body = await response.text();
      if (body.length > 40000000) throw new Error('单次响应过大，请减小 batchSize');
      let result;
      try { result = JSON.parse(body); } catch { throw new Error(`${path} 没有返回 JSON，可能已经跳转登录页`); }
      if (result?.code !== 0 || !result.data || typeof result.data !== 'object') throw new Error(`${path} 业务错误，code=${String(result?.code)}；停止提取`);
      responses.push({ url: url.toString(), status: response.status, body, captured_at: new Date().toISOString() });
      return result.data;
    } finally { clearTimeout(timer); }
  }
  function pid(value     )         {
    if (typeof value !== 'string' || !value.length) throw new Error('段落 ID 不是字符串，可能发生接口漂移；停止以免丢失精度');
    return value;
  }
  const ids           = [];
  const known = new Set        ();
  let indexComplete = false;
  for (let page = 0; page < maxPages; page++) {
    const data = await get('subtitles/paragraph-ids', { page_size: '10000', page_num: String(page) });
    if (!Array.isArray(data.list) || typeof data.has_more !== 'boolean') throw new Error('段落索引结构已变化');
    for (const item of data.list) {
      const value = pid(item.pid);
      if (known.has(value)) throw new Error('索引出现重复 ID；请在会议编辑结束后重新提取');
      known.add(value); ids.push(value);
    }
    if (!data.has_more) { indexComplete = true; break; }
    if (!data.list.length) throw new Error('索引 has_more=true 但没有新段落；停止分页');
  }
  if (!indexComplete) throw new Error('达到索引分页上限，未获取完整索引');
  if (!ids.length) throw new Error('本妙记没有可提取的文字记录');
  const speakers = await get('speakers', { size: '10000', translate_lang: 'default' });
  if (speakers.has_more !== false || !speakers.paragraph_to_speaker || !speakers.speaker_info_map) {
    throw new Error('发言人映射不完整或结构变化；请用 HAR 模式检查当前接口，不猜测分页协议');
  }
  const received = new Map                ();
  const versions = new Set        ();
  for (let start = 0; start < ids.length; start += batchSize) {
    const batch = ids.slice(start, start + batchSize);
    const data = await get('subtitles_v2', { paragraph_id: batch[0], size: String(batch.length),
      translate_lang: 'default', is_fluent: 'false', filter_speaker: 'true' });
    if (!Array.isArray(data.paragraphs) || data.translate_lang !== 'default' || data.total !== ids.length) {
      throw new Error('字幕结构、语言或总段数与索引不一致；停止以免输出伪全文');
    }
    versions.add(JSON.stringify([data.version, data.last_edit_version]));
    if (versions.size > 1) throw new Error('提取期间字幕版本变化，请重新运行');
    for (const paragraph of data.paragraphs) {
      const value = pid(paragraph.pid);
      if (!known.has(value)) throw new Error('字幕返回了不在索引内的段落，请重新捕获');
      const serialized = JSON.stringify(paragraph);
      if (received.has(value) && received.get(value) !== serialized) throw new Error('字幕段落在提取期间变化');
      received.set(value, serialized);
    }
    if (batch.some(value => !received.has(value))) throw new Error('字幕批次没有覆盖请求的段落；请重新检查接口，不能只凭 has_more 判断完整');
  }
  if (received.size !== ids.length || ids.some(value =>
    !speakers.speaker_info_map[speakers.paragraph_to_speaker[value]])) throw new Error('正文或发言人映射覆盖不完整');
  return { format: 'feishu-minutes-capture/v1', source_url: sourceUrl, title: options.title,
    captured_at: new Date().toISOString(), responses };
}

  try {
    const capture = await captureMinutes({ sourceUrl: location.href, title: document.title });
    const blob = new Blob([JSON.stringify(capture, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = new URL(capture.source_url).pathname.split('/').pop() + '.capture.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    console.info('妙记原始响应已下载。请用 Skill 中的 CLI 做完整性复核及文本/字幕导出。');
  } catch (error) {
    console.error('妙记提取已停止：', error.message);
  }
})();
