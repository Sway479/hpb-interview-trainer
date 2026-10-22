import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createApp } from '../server/app.ts';
import { resolve } from 'node:path';

const { app } = await createApp({ dataDirectory: '.cache/mcp-verification-data', serveStatic: false,
  qwen: { apiKey: '', url: 'wss://maas.qianwenaiapi.com/api-ws/v1/realtime', model: 'qwen-audio-3.1-realtime-plus', voice: 'longanqian_v3.1' } });
const url = await app.listen({ host: '127.0.0.1', port: 0 });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [resolve('node_modules/tsx/dist/cli.mjs'), resolve('server/mcp.ts')], cwd: resolve('.cache/mcp-client-cwd'),
  env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', HPB_SERVER_URL: url }, stderr: 'pipe' });
const client = new Client({ name: 'prototype-mcp-verification', version: '0.1.0' });
const receipt: Record<string, unknown> = { at: new Date().toISOString(), checks: [] };
const check = (text: string) => (receipt.checks as string[]).push(text);
const decode = (result: any) => JSON.parse(result.content.find((block: any) => block.type === 'text').text);
try {
  await mkdir('.cache/mcp-client-cwd', { recursive: true });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 6); receipt.tools = tools.map(t => t.name); check('mcp_stdio_connects_and_lists_six_tools');
  const cases = decode(await client.callTool({ name: 'list_cases', arguments: {} }));
  assert.equal(cases.length, 4); assert.ok(cases.every((c: any) => !c.facts && !c.rubric)); check('same_public_case_contract_without_hidden_facts');
  const session = decode(await client.callTool({ name: 'start_interview', arguments: { caseId: cases[0].id } }));
  const viaHttp = await (await fetch(`${url}/api/sessions/${session.id}`)).json() as any;
  assert.equal(viaHttp.id, session.id); assert.equal(viaHttp.caseVersion, session.caseVersion); check('mcp_and_http_share_same_persistent_session');
  const early = await client.callTool({ name: 'submit_independent_summary', arguments: { sessionId: session.id,
    history: '问诊还没有结束不能提前提交总结', reasoning: '测试', plan: '测试', uncertainty: '测试' } });
  assert.equal(early.isError, true); check('mcp_cannot_bypass_summary_gate');
  const ended = decode(await client.callTool({ name: 'end_interview', arguments: { sessionId: session.id } }));
  assert.equal(ended.status, 'summary'); check('mcp_updates_same_core_state');
  receipt.status = 'passed';
} catch (error) { receipt.status = 'failed'; receipt.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally { await client.close(); await app.close(); await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/mcp-verification.json', JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt, null, 2)); }
