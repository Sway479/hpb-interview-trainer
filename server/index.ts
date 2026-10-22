import dotenv from 'dotenv';
import { createApp } from './app.ts';
dotenv.config({ quiet: true });

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8787);
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !process.env.APP_ACCESS_TOKEN) {
  throw new Error('局域网模式需要 APP_ACCESS_TOKEN 配对码。请用 tools/start-lan.ps1 启动。');
}
const { app } = await createApp({
  qwen: { apiKey: process.env.QIANWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? '',
    url: process.env.QWEN_REALTIME_URL ?? 'wss://maas.qianwenaiapi.com/api-ws/v1/realtime',
    model: process.env.QWEN_REALTIME_MODEL ?? 'qwen-audio-3.1-realtime-plus',
    voice: process.env.QWEN_VOICE ?? 'longanqian_v3.1' },
  accessToken: process.env.APP_ACCESS_TOKEN,
  flash: {
    apiKey: process.env.QIANWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? '',
    url: process.env.QWEN_FLASH_URL ?? 'https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions',
    model: process.env.QWEN_FLASH_MODEL ?? 'qwen3.8-flash',
  },
});
await app.listen({ host, port });
console.log(`问诊陪练本地服务已启动：http://${host}:${port}`);
console.log(`实时模型：${process.env.QWEN_REALTIME_MODEL ?? 'qwen-audio-3.1-realtime-plus'}；长期密钥仅由服务端读取。`);
console.log(`病例与评分内核：${process.env.QWEN_FLASH_MODEL ?? 'qwen3.8-flash'}（关闭思考模式）。`);
if (process.env.APP_ACCESS_TOKEN) console.log(`安卓配对码：${process.env.APP_ACCESS_TOKEN}`);
const shutdown = async () => { await app.close(); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
