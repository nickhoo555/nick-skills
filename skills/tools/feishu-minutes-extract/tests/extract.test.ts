import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { captureMinutes } from '../scripts/capture.ts';
import { extract, fromHar, parseLossless, parseSource, renderSrt, renderText, sha256 } from '../scripts/core.ts';
import type { Capture, RawResponse } from '../scripts/core.ts';

// Synthetic content only. No meeting data, cookies, tenant identity or real user identifiers.
const source = 'https://example.feishu.cn/minutes/obcFixture';
const pids = ['9000000000000000001', '9000000000000000002'];
const sid = '8000000000000000001';
const api = (path: string, query: Record<string, string> = {}) =>
  `https://example.feishu.cn/minutes/api/${path}?` + new URLSearchParams({ object_token: 'obcFixture', ...query });
const indexData = (start = 0, count = 2, more = false) => ({ has_more: more,
  list: pids.slice(start, start + count).map((pid, i) => ({ pid, start_time: String((start + i) * 1000), stop_time: String((start + i) * 1000 + 900) })) });
const speakersData = () => ({ has_more: false, total: 2,
  paragraph_to_speaker: Object.fromEntries(pids.map(pid => [pid, sid])),
  speaker_info_map: { [sid]: { user_id: sid, user_name: '测试发言人' } }, unknown_field: { retained: true } });
const paragraph = (i: number) => ({ pid: pids[i], start_time: String(i * 1000), stop_time: String(i * 1000 + 900),
  paragraph_type: 0, sentences: [{ sid: `sentence-${i}`, start_time: String(i * 1000), stop_time: String(i * 1000 + 900),
    language: 'zh_cn', contents: [{ cid: `word-${i}`, start_time: String(i * 1000), stop_time: String(i * 1000 + 900),
      content: i ? ' world.\n下一行' : '你好，', language: i ? 'en_us' : 'zh_cn' }] }] });
const subtitlesData = (start = 0, count = 2) => ({ total: 2, size: count, version: 0, last_edit_version: 0,
  translate_lang: 'default', has_more: start + count < 2, paragraphs: Array.from({ length: count }, (_, i) => paragraph(start + i)) });
const response = (path: string, data: any, query: Record<string, string> = {}): RawResponse => ({ url: api(path, query), status: 200,
  body: JSON.stringify({ code: 0, msg: 'success', data }, null, 2) });
const sample = (): Capture => ({ format: 'feishu-minutes-capture/v1', source_url: source, title: '合成会议', responses: [
  response('subtitles/paragraph-ids', indexData(), { page_num: '0', page_size: '10000' }),
  response('speakers', speakersData(), { size: '10000', translate_lang: 'default' }),
  response('subtitles_v2', subtitlesData(), { paragraph_id: pids[0], size: '2', translate_lang: 'default', is_fluent: 'false', filter_speaker: 'true' }),
] });
function mutate(c: Capture, i: number, edit: (data: any) => void) {
  const body = JSON.parse(c.responses[i].body); edit(body.data); c.responses[i].body = JSON.stringify(body);
}
function har(c = sample()) {
  return { log: { entries: c.responses.map(r => ({ request: { url: r.url, method: 'GET', headers: [{ name: 'Cookie', value: 'DO-NOT-EXPORT' }] },
    response: { status: r.status, content: { text: r.body } } })) } };
}

test('complete extraction preserves strings, tokens and millisecond timings', () => {
  const { transcript: t, completeness, responses } = extract(sample());
  assert.equal(completeness.complete, true);
  assert.deepEqual(t.counts, { paragraphs: 2, sentences: 2, tokens: 2, speakers: 1 });
  assert.equal(t.paragraphs[0].id, pids[0]);
  assert.equal(t.paragraphs[1].speaker_id, sid);
  assert.equal(t.paragraphs[1].text, ' world.\n下一行');
  assert.equal(t.paragraphs[1].sentences[0].tokens[0].start_ms, 1000);
  assert.equal(responses[1].body, sample().responses[1].body);
  assert.match(responses[1].body, /unknown_field/);
});
test('lossless parser protects oversized integers without touching escaped string content', () => {
  const data = parseLossless('{"id":8000000000000000001,"negative":-8000000000000000001,"text":"123 \\\" 8000000000000000001","ok":123,"decimal":1.25,"exponent":1e3}');
  assert.equal(data.id, sid); assert.equal(data.negative, '-' + sid);
  assert.equal(data.text, '123 \\" 8000000000000000001'.replace('\\"', '"'));
  assert.equal(data.decimal, 1.25); assert.equal(data.exponent, 1000);
  assert.throws(() => parseLossless('{"n":012345678901234567890}'));
});
test('HAR importer whitelists meeting endpoints and never carries request headers', () => {
  const h = har();
  h.log.entries.push({ request: { url: 'https://elsewhere.example/?object_token=obcFixture', method: 'GET', headers: [] },
    response: { status: 200, content: { text: 'SENSITIVE-UNRELATED' } } });
  const c = fromHar(h, source);
  assert.equal(c.responses.length, 3);
  assert.equal(JSON.stringify(c).includes('DO-NOT-EXPORT'), false);
  assert.equal(JSON.stringify(c).includes('SENSITIVE-UNRELATED'), false);
  assert.equal(extract(c).completeness.complete, true);
});
test('HAR base64 and plain text produce identical original response bodies', () => {
  const h = har();
  for (const entry of h.log.entries) (entry.response.content as any) = {
    encoding: 'base64', text: Buffer.from(entry.response.content.text, 'utf8').toString('base64') };
  assert.deepEqual(fromHar(h, source).responses.map(r => r.body), sample().responses.map(r => r.body));
});
test('missing HAR bodies are fatal, not silently skipped', () => {
  const h = har(); delete (h.log.entries[0].response.content as any).text;
  assert.throws(() => fromHar(h, source), /缺少.*响应正文/);
});
test('translated and fluent HAR requests are excluded from source transcript import', () => {
  const h = har(); h.log.entries[2].request.url = h.log.entries[2].request.url.replace('is_fluent=false', 'is_fluent=true');
  assert.throws(() => extract(fromHar(h, source)), /完整性/);
});
test('scope and request URL sanitization', () => {
  for (const url of ['http://example.feishu.cn/minutes/a', 'https://feishu.cn.evil.example/minutes/a',
    'https://user:pass@example.feishu.cn/minutes/a', 'https://example.feishu.cn:444/minutes/a', 'https://example.feishu.cn/minutes/api']) {
    assert.throws(() => parseSource(url));
  }
  const c = sample(); c.responses[0].url += '&authorization=DO-NOT-EXPORT';
  assert.equal(extract(c).responses[0].url.includes('authorization'), false);
  c.responses[0].url = c.responses[0].url.replace('obcFixture', 'obcAnother');
  assert.throws(() => extract(c), /跨会议/);
});
test('missing paragraphs fail closed; allowPartial is explicitly labeled', () => {
  const c = sample(); mutate(c, 2, d => { d.paragraphs.pop(); });
  assert.throws(() => extract(c), /缺少 1 段/);
  const partial = extract(c, { allowPartial: true });
  assert.equal(partial.completeness.complete, false);
  assert.deepEqual(partial.completeness.missing_paragraph_ids, [pids[1]]);
  assert.match(renderText(partial.transcript), /不完整导出/);
});
test('coverage, not last subtitle has_more, establishes completeness', () => {
  const c = sample(); const first = c.responses.pop()!;
  const a = { ...first, body: JSON.stringify({ code: 0, data: subtitlesData(0, 1) }) };
  const b = { ...first, url: first.url.replace(pids[0], pids[1]), body: JSON.stringify({ code: 0, data: subtitlesData(1, 1) }) };
  c.responses.push(a, b);
  assert.equal(extract(c).completeness.complete, true);
});
test('missing index pages or has_more index flag cannot claim full capture', () => {
  const c = sample(); mutate(c, 0, d => { d.has_more = true; });
  assert.throws(() => extract(c), /索引未完整/);
  const d = sample(); d.responses[0].url = d.responses[0].url.replace('page_num=0', 'page_num=1');
  assert.throws(() => extract(d), /索引未完整/);
});
test('contiguous multi-page index is accepted', () => {
  const c = sample(); mutate(c, 0, d => { d.list = d.list.slice(0, 1); d.has_more = true; });
  c.responses.push(response('subtitles/paragraph-ids', indexData(1, 1), { page_num: '1' }));
  assert.equal(extract(c).completeness.complete, true);
});
test('speaker mapping and names are required', () => {
  const c = sample(); mutate(c, 1, d => { delete d.paragraph_to_speaker[pids[1]]; });
  assert.throws(() => extract(c), /发言人映射/);
});
test('HTTP, business and login errors stop without retries', () => {
  const c = sample(); c.responses[0].status = 403;
  assert.throws(() => extract(c), /HTTP 403/);
  c.responses[0].status = 200; c.responses[0].body = '{"code":403}';
  assert.throws(() => extract(c), /业务错误/);
  c.responses[0].body = '<html>Login</html>';
  assert.throws(() => extract(c), /登录页/);
});
test('changed or incompatible snapshots are rejected even with allowPartial', () => {
  const c = sample(); const duplicate = structuredClone(c.responses[2]);
  const b = JSON.parse(duplicate.body); b.data.paragraphs[0].sentences[0].contents[0].content = 'changed';
  duplicate.body = JSON.stringify(b); c.responses.push(duplicate);
  assert.throws(() => extract(c, { allowPartial: true }), /段落.*变化/);
  const d = sample(); const version = structuredClone(d.responses[2]);
  const data = JSON.parse(version.body); data.data.version = 1; version.body = JSON.stringify(data); d.responses.push(version);
  assert.throws(() => extract(d), /版本/);
});
test('schema drift and inconsistent timing are rejected', () => {
  const c = sample(); mutate(c, 2, d => { d.paragraphs[0].sentences[0].contents[0].content = null; });
  assert.throws(() => extract(c), /原始字符串/);
  const d = sample(); mutate(d, 2, p => { p.paragraphs[0].stop_time = '1'; });
  assert.throws(() => extract(d), /时间与索引不一致/);
});
test('text and SRT exports are deterministic and keep original spaces', () => {
  const t = extract(sample()).transcript;
  assert.match(renderText(t), /00:00:01\.000 → 00:00:01\.900/);
  assert.match(renderSrt(t), /00:00:01,000 --> 00:00:01,900\n测试发言人:  world\./);
});

const replay = (pagination = false) => {
  const urls: string[] = [];
  const transport = async (url: string) => {
    urls.push(url); const u = new URL(url); let data;
    if (u.pathname.endsWith('paragraph-ids')) data = pagination
      ? indexData(Number(u.searchParams.get('page_num')), 1, u.searchParams.get('page_num') === '0') : indexData();
    else if (u.pathname.endsWith('/speakers')) data = speakersData();
    else { const start = pids.indexOf(u.searchParams.get('paragraph_id')!); data = subtitlesData(start, Number(u.searchParams.get('size'))); }
    return { status: 200, text: async () => JSON.stringify({ code: 0, data }) };
  };
  return { urls, transport };
};
test('browser collector replays the observed protocol in sequential original-text batches', async () => {
  const { urls, transport } = replay(true);
  const c = await captureMinutes({ sourceUrl: source, batchSize: 1 }, transport);
  assert.equal(urls.length, 5);
  assert.equal(extract(c).completeness.complete, true);
  assert.equal(urls.filter(u => u.includes('is_fluent=false')).length, 2);
});
test('browser collector enforces page bound', async () => {
  const { transport } = replay(true);
  await assert.rejects(captureMinutes({ sourceUrl: source, maxIndexPages: 1 }, transport), /分页上限/);
});
test('browser collector fails on permission denial without re-requesting', async () => {
  let calls = 0;
  await assert.rejects(captureMinutes({ sourceUrl: source }, async () => {
    calls++; return { status: 401, text: async () => '' };
  }), /HTTP 401/);
  assert.equal(calls, 1);
});
test('browser collector rejects truncated batches instead of accepting a final flag', async () => {
  const { transport } = replay();
  await assert.rejects(captureMinutes({ sourceUrl: source }, async (url, signal) => {
    const r = await transport(url); if (!url.includes('subtitles_v2')) return r;
    const body = JSON.parse(await r.text()); body.data.paragraphs.pop(); body.data.has_more = false;
    return { status: 200, text: async () => JSON.stringify(body) };
  }), /没有覆盖/);
});
test('browser collector aborts timeout and does not retry', async () => {
  let calls = 0;
  await assert.rejects(captureMinutes({ sourceUrl: source, timeoutMs: 5 }, async (_url, signal) => {
    calls++; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  }), /aborted/);
  assert.equal(calls, 1);
});
test('generated browser entrypoint downloads the raw capture using only same-origin GET', async () => {
  const { transport } = replay();
  let download = ''; let downloaded: Blob | undefined;
  class TestURL extends URL {
    static createObjectURL(blob: Blob) { downloaded = blob; return 'blob:synthetic-test'; }
    static revokeObjectURL(_url: string) {}
  }
  const code = await readFile(new URL('../scripts/browser-export.js', import.meta.url), 'utf8');
  await runInNewContext(code, {
    URL: TestURL, URLSearchParams, Blob, AbortController, location: { href: source },
    document: { title: '合成会议', createElement: () => ({ href: '', download: '', click() { download = this.download; } }) },
    fetch: async (url: string, options: any) => {
      assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'same-origin');
      assert.equal(options.redirect, 'error');
      assert.equal(new URL(url).origin, new URL(source).origin);
      return transport(url);
    },
    setTimeout: (fn: () => void, ms: number) => ms === 60000 ? 0 : setTimeout(fn, ms), clearTimeout,
    console: { info() {}, error(...args: any[]) { throw new Error(args.join(' ')); } },
  });
  assert.equal(download, 'obcFixture.capture.json');
  const c = JSON.parse(await downloaded!.text());
  assert.equal(extract(c).completeness.complete, true);
  assert.equal(c.responses[0].body, JSON.stringify({ code: 0, data: indexData() }));
});
test('CLI preserves exact raw bytes and refuses existing output directories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'minutes-extract-test-'));
  try {
    const input = join(dir, 'fixture.har'); const out = join(dir, 'export');
    await writeFile(input, JSON.stringify(har()));
    const cli = fileURLToPath(new URL('../scripts/cli.ts', import.meta.url));
    const args = [cli, '--har', input, '--url', source, '--out', out];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    assert.equal(manifest.completeness.complete, true);
    for (const [i, raw] of manifest.responses.entries()) {
      const bytes = await readFile(join(out, raw.file));
      assert.equal(bytes.toString('utf8'), sample().responses[i].body);
      assert.equal(sha256(bytes.toString('utf8')), raw.sha256);
      assert.equal((await stat(join(out, raw.file))).mode & 0o777, 0o600);
    }
    assert.equal(spawnSync(process.execPath, args).status, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
