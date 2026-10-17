import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { extract, fromHar, parseLossless, parseSource, renderSrt, renderText, sha256 } from './core.ts';
import type { Capture } from './core.ts';

const help = `飞书妙记原始文字记录提取器（Node >=22.18，无第三方依赖）

node scripts/cli.ts --har <会议.har> --url <妙记URL> --out <新目录> [--title <标题>]
node scripts/cli.ts --capture <浏览器.capture.json> --out <新目录> [--url <妙记URL>]

--allow-partial  明确允许不完整导出，manifest / transcript 会标记 complete=false
--help          显示帮助

默认严格检查索引、正文和发言人映射。输出目录必须不存在；不覆盖已有数据。
raw/*.json 保留响应正文原始 UTF-8 文本；不保存 Cookie、请求头或 HTML。`;

async function main() {
  const { values } = parseArgs({ options: { har: { type: 'string' }, capture: { type: 'string' },
    url: { type: 'string' }, out: { type: 'string' }, title: { type: 'string' },
    'allow-partial': { type: 'boolean' }, help: { type: 'boolean' } }, strict: true });
  if (values.help) { console.log(help); return; }
  if (Boolean(values.har) === Boolean(values.capture) || !values.out) throw new Error(help);
  let capture: Capture;
  if (values.har) {
    if (!values.url) throw new Error('HAR 模式必须提供 --url，用于限制会议和站点范围');
    capture = fromHar(parseLossless(await readFile(resolve(values.har), 'utf8')), values.url);
  } else {
    capture = parseLossless(await readFile(resolve(values.capture!), 'utf8'));
    if (values.url && parseSource(values.url).url !== parseSource(capture.source_url).url) {
      throw new Error('--url 与捕获文件 source_url 不一致');
    }
  }
  const result = extract(capture, { allowPartial: values['allow-partial'], title: values.title });
  const out = resolve(values.out);
  await mkdir(dirname(out), { recursive: true });
  await mkdir(out, { mode: 0o700 }); // EEXIST deliberately fails; never overwrite.
  await mkdir(join(out, 'raw'), { mode: 0o700 });
  const save = (name: string, text: string) => writeFile(join(out, name), text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const raw = [];
  for (const [i, response] of result.responses.entries()) {
    const endpoint = new URL(response.url).pathname.split('/').at(-1)!;
    const file = `raw/${String(i + 1).padStart(4, '0')}-${endpoint}.json`;
    await save(file, response.body);
    raw.push({ file, url: response.url, http_status: response.status,
      captured_at: response.captured_at ?? null, sha256: sha256(response.body), bytes: Buffer.byteLength(response.body, 'utf8') });
  }
  await save('transcript.json', JSON.stringify(result.transcript, null, 2) + '\n');
  await save('transcript.txt', renderText(result.transcript));
  await save('transcript.srt', renderSrt(result.transcript));
  // The manifest is the completion marker and is always written last.
  await save('manifest.json', JSON.stringify({ format: 'feishu-minutes-export/v1',
    source_url: parseSource(capture.source_url).url, title: result.transcript.title,
    exported_at: new Date().toISOString(), input_type: values.har ? 'har' : 'browser-capture',
    raw_preservation: 'HTTP 解压后的响应正文 UTF-8 文本；不等同于压缩后的网络包；未知字段保留在 raw 文件中',
    completeness: result.completeness, counts: result.transcript.counts, responses: raw }, null, 2) + '\n');
  console.log(JSON.stringify({ out, complete: result.completeness.complete, ...result.transcript.counts }, null, 2));
  if (!result.completeness.complete) console.error('警告：这是用户明确允许的不完整导出，不能宣称已获取全文。');
}

main().catch(error => { console.error(`提取失败：${error.message}`); process.exitCode = 1; });
