import { readFile, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const input = await readFile(new URL('./capture.ts', import.meta.url), 'utf8');
const code = stripTypeScriptTypes(input)
  .replace('export async function captureMinutes', 'async function captureMinutes')
  .replace(/[ \t]+$/gm, '');
const wrapper = `/* Generated from capture.ts. Read-only same-origin GETs, one local JSON download. */
(async () => {
${code}
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
`;
await writeFile(new URL('./browser-export.js', import.meta.url), wrapper, 'utf8');
console.log('Generated scripts/browser-export.js');
