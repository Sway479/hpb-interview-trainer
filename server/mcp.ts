import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// This adapter calls the running teaching service; it never receives a Qwen key.
const base = (process.env.HPB_SERVER_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const token = process.env.HPB_ACCESS_TOKEN ?? '';
const server = new McpServer({ name: 'hpb-interview-training', version: '0.1.0' });
async function call(path: string, body?: unknown) {
  try {
    const response = await fetch(`${base}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(80000),
    });
    const result = await response.json();
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], isError: !response.ok };
  } catch (error) {
    return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : '本地教学服务不可用' }], isError: true };
  }
}
const id = z.string().uuid().describe('同一教学服务返回的会话ID');
server.registerTool('list_cases', { description: '列出可练习的虚构临床问诊病例，不返回隐藏事实或评分要点。', inputSchema: {} }, () => call('/cases'));
server.registerTool('start_interview', { description: '创建问诊会话，可在安卓端或本工具继续同一病例。', inputSchema: { caseId: z.string() } }, ({ caseId }) => call('/sessions', { caseId }));
server.registerTool('get_interview', { description: '查看会话的已保存转录、状态、已提交总结及可用反馈。', inputSchema: { sessionId: id } }, ({ sessionId }) => call(`/sessions/${sessionId}`));
server.registerTool('ask_patient', { description: '向模拟患者发问，通过已配置的真实千问模型回答。仅问诊中允许，活动语音连接需先断开。', inputSchema: { sessionId: id, question: z.string().min(1).max(3000) } }, ({ sessionId, question }) => call(`/sessions/${sessionId}/text`, { text: question }));
server.registerTool('end_interview', { description: '结束问诊并开放独立总结；结束后不能继续添加问诊记录。', inputSchema: { sessionId: id } }, ({ sessionId }) => call(`/sessions/${sessionId}/end`, {}));
server.registerTool('submit_independent_summary', {
  description: '结束问诊后提交学员独立完成的病史摘要、判断依据、待核实计划及不确定性，再生成待教师复核的反馈。',
  inputSchema: { sessionId: id, history: z.string().min(10), reasoning: z.string().min(2), plan: z.string().min(2), uncertainty: z.string().min(2) },
}, ({ sessionId, ...summary }) => call(`/sessions/${sessionId}/summary`, summary));
await server.connect(new StdioServerTransport());
