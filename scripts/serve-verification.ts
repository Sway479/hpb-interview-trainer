import dotenv from 'dotenv';
import { createApp } from '../server/app.ts';
dotenv.config({ quiet: true });
const { app } = await createApp({ dataDirectory: '.cache/browser-verification-data',
  qwen: { apiKey: process.env.DASHSCOPE_API_KEY!, url: process.env.QWEN_REALTIME_URL!, model: process.env.QWEN_REALTIME_MODEL!, voice: process.env.QWEN_VOICE! },
  flash: { apiKey: process.env.DASHSCOPE_API_KEY!, url: process.env.QWEN_FLASH_URL!, model: process.env.QWEN_FLASH_MODEL! } });
await app.listen({ host: '127.0.0.1', port: 8788 });
console.log('Synthetic UI verification workspace listening on http://127.0.0.1:8788');
const shutdown = async () => { await app.close(); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
