# Legacy 电脑教学服务接口 v0.1

本文件记录保留的电脑HTTP/WebSocket/MCP路径，供v0.1网关客户端或外部运行框架使用。**v0.2安卓手机默认不调用这些接口，也不需要启动电脑服务。**

两个运行路径复用病例、量规与反馈校验的核心代码，但会话与录音分别保存在电脑和手机，未实现自动同步。旧单会话JSON不是v0.2 BackupData，不能直接导入手机。

启动电脑服务仅用于此可选路径，按旧服务的配置示例提供服务凭证；凭证留在该电脑。局域网配对码仅用于旧网关访问，不是v0.2手机API Key。

## 历史接口

基址默认 `http://127.0.0.1:8787`。浏览器同源访问；Android 模拟器默认使用 `http://10.0.2.2:8787`，USB 真机可用 `adb reverse tcp:8787 tcp:8787` 后连接 `http://127.0.0.1:8787`。局域网模式须设置配对码 `APP_ACCESS_TOKEN`，HTTP 请求带 `Authorization: Bearer <配对码>`，语音连接在首个 connect 消息中传 token。长期模型密钥从不下发。

## HTTP

- `GET /api/health` → `{status:'ok',configured,model,endpoint,requiresToken}`。仅配置状态，不等同于上游实时连通。
- `GET /api/cases` → `CasePreview[]`。只含可给学员看的资料。
- `GET /api/assessment` → 本课题改编量规的名称、版本、公开参考来源与适用限制；不含病例隐藏资料或专属核对点。
- `GET /api/sessions` → `Session[]`（按时间倒序，本地单用户工作区）。
- `POST /api/sessions` body `{caseId}` → `Session`。
- `GET /api/sessions/:id` → `Session`。
- `POST /api/sessions/:id/text` body `{text}` → `Session`。供文字补充和外部 harness 调用，患者通过真实 Qwen 模型回答。
- `POST /api/sessions/:id/end` → `Session`，状态 interview → summary。
- `POST /api/sessions/:id/summary` body `LearnerSummary` → `Session`，先保存独立总结，再调用 Qwen 生成反馈，成功后 feedback_ready。模型错误返回可读错误并保存总结供重试，不伪造成功反馈。
- `POST /api/sessions/:id/review` body `{reviewer,notes}` → `Session`，本地带教复核备注。
- `GET /api/sessions/:id/export` → JSON 附件，含原文、总结、反馈、复核；不含 API Key 或病例隐藏资料。
- `GET /api/sessions/:id/audio?role=learner|patient` → WAV，分别为16kHz学员连续录音、24kHz患者合成音频；两轨未作逐句同步对齐。

HTTP 错误结构 `{error:string}`。非法状态返回 409；字段错误返回 400。

## WebSocket

连接 `/api/voice`。首个客户端消息为 `{type:'connect',sessionId,token?}`，服务端接入 Qwen 并回 ready；其余消息及返回事件见 `packages/core/src/types.ts`。

客户端连续发送 `{type:'audio',audio:<base64 PCM16LE 16kHz mono>}`。输入使用服务端 VAD，输出 `{type:'audio',audio,itemId}` 为 PCM16LE 24kHz mono。检测到学员开口时清除正在播放的音频。也支持 text、interrupt、finish；客户端不可传入系统指令、私有病例或上游任意事件。

服务端将实时语音模型的 `lookup_patient_reply` Function Calling 请求交给 `qwen3.8-flash` 病例内核。`reasoning_started`/`reasoning_done` 反映当前轮Flash请求，过期或已打断轮次不会回填旧答案。只有经过当前轮内核回填的语音响应允许下发；这说明模型链路经过内核，不能独立证明语音逐字复述。最终字幕与Flash答案做去标点空白后的核对，不一致时标记 `verification:'paraphrase_unverified'`、`final:false` 并发送 `quality_warning`，供教师复核。

反馈由Flash生成结构化项目判定，再由服务端验证条目、分值范围、原文引用与记录完整性。`Feedback.assessment` 保存量规来源与版次；`scoreSummary` 按病例信息、沟通过程两组提供已评部分参考分和覆盖率，未观察/证据不足为null，不自动计0，也不合并成100分合格判断。

问诊结束后，voice 连接不可继续写入；反馈必须在提交独立总结后生成。错误/断线保留已确认转录；重新连接会重建病例约束和已保存对话，但不恢复未确认的音频。

## 跨运行框架

`server/mcp.ts` 提供 MCP stdio 适配器，通过上述 HTTP 接口调用共享会话内核。Android 与外部工具使用相同病例版本、会话状态和反馈顺序。MCP 配置示例随 README 提供；无需为每个 harness 复制病例或另建语音模型会话规则。


## MCP客户端示例（仅连接电脑网关）

```json
{
  "mcpServers": {
    "hpb-interview-legacy": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": [
        "C:/path/to/hpb-interview-trainer/node_modules/tsx/dist/cli.mjs",
        "C:/path/to/hpb-interview-trainer/server/mcp.ts"
      ],
      "env": {
        "HPB_SERVER_URL": "http://127.0.0.1:8787"
      }
    }
  }
}
```

路径按实际项目位置修改。网关启用配对时增加HPB_ACCESS_TOKEN，不向MCP客户端提供模型长期密钥。工具为list_cases、start_interview、get_interview、ask_patient、end_interview、submit_independent_summary。

server/mcp.ts保留v0.1服务身份；其中提到与安卓端续用同一会话的文案指旧网关客户端，不能据此认为v0.2本机数据已经与电脑同步。

