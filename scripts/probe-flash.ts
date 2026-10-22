import dotenv from 'dotenv';
import { completeFlash } from '../server/flash.ts';
import { mkdir, writeFile } from 'node:fs/promises';
dotenv.config({ quiet: true });
const started = Date.now();
const model = process.env.QWEN_FLASH_MODEL ?? 'qwen3.8-flash';
const url = process.env.QWEN_FLASH_URL ?? 'https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions';
const receipt: Record<string, unknown> = { at: new Date().toISOString(), requestedModel: model, endpoint: new URL(url).hostname, thinking: false };
try {
  const text = await completeFlash({ apiKey: process.env.DASHSCOPE_API_KEY!, url, model },
    '这是软件连通测试。只回复一句中文，不使用工具，不输出任何用户或环境信息。', '请回复：Flash接口已接通。');
  receipt.reply = text; receipt.status = 'passed';
} catch (error) { receipt.status = 'failed'; receipt.error = error instanceof Error ? error.message : '请求失败'; process.exitCode = 1; }
receipt.elapsedMs = Date.now() - started;
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/qwen-flash-probe.json', JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
