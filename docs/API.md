# 应用接口与数据契约 v0.2

v0.2 Android App 通过 TypeScript 应用接口调用本机状态层，再通过原生桥直接请求所选 API。**当前手机流程没有必需的 HTTP 教学服务器、电脑 IP 或配对码。**

入口为 `apps/mobile/src/api.ts`；数据类型在 `apps/mobile/src/platform/contracts.ts` 和 `packages/core/src/types.ts`。原生方法、KeyStore、网络与文件实现见 [NATIVE_BRIDGE.md](NATIVE_BRIDGE.md)。保留的电脑 HTTP/WebSocket/MCP 接口单独列在 [API_LEGACY.md](API_LEGACY.md)，其数据与手机本机数据不自动同步。

## 1. API 配置

```ts
interface ProviderProfile {
  id: string;
  name: string;
  company: 'qwen' | 'openai' | 'deepseek' | 'custom';
  chatUrl: string;
  chatModel: string;
  realtimeProtocol: 'qwen' | 'openai' | 'none';
  realtimeUrl: string;
  realtimeModel: string;
  voice: string;
  hasKey?: boolean;
}
interface ConnectionSettings {
  mode: 'standalone';
  profiles: ProviderProfile[];
  textProfileId: string;
  voiceProfileId: string; // empty string = text only
}
```

配置不含 Key 明文。Key 作为单独的保存参数传给原生凭证存储；没有读取已存 Key 的应用接口。

| 调用 | 返回/行为 |
|---|---|
| `readSettings()` | 同步读取非敏感缓存或默认配置；不能替代原生持久配置加载 |
| `api.settings()` | `Promise<ConnectionSettings>`，加载持久配置；App 启动时等待此结果 |
| `validateSettings(settings)` | 规范化并校验配置、选中 ID、模型及实时协议 |
| `saveSettings(settings)` | 异步保存非敏感用途/配置，返回已保存配置 |
| `api.saveProfile(profile, key?)` | 保存配置；有新 Key 时在安卓原生层加密保存，返回 settings |
| `api.deleteProfile(id)` | 删除配置及其原生密钥，返回 settings；至少保留一套配置。未结束问诊使用的文本/语音配置，以及待生成或重试反馈所需的文本配置受删除保护 |
| `api.credentialStatus(ids)` | `Record<id,{hasKey:boolean}>`；无 Key 值 |
| `api.health(settings)` | 本机配置/Key存在状态及存储告警；不访问模型，不表示网络已接通 |
| `api.probe(settings,'text'|'voice')` | 主动检测对应 API，返回 `{ok,capability,message,model?}`；可能产生 API 用量 |

文本入口只接受规范化的 HTTPS Chat Completions 完整地址或兼容基址，实时入口为 WSS；不在 URL 中放 Key。更换已经绑定 Key 的域名需重新填写 Key，原生层进一步核对允许的 origin。

默认公司模板以 `platform/settings.ts` 为准。千问使用项目指定兼容入口及指定 Flash/Audio 模型；OpenAI 使用单独的实时会话 schema；DeepSeek 只允许文本。自定义接口仅限已实现的兼容格式。协议适配或模拟测试不代表该公司的真实账号/模型已验证，本轮未使用其他公司真实 Key 完成服务商验收。

浏览器可以持久化非敏感配置；不持久化 Key。原生 API 检测在浏览器返回明确不可用提示，前端不会伪造检测成功。

## 2. 病例与会话

| 调用 | 返回/行为 |
|---|---|
| `api.cases(settings?)` | 本机 `CasePreview[]`，仅学员可见的预览 |
| `api.sessions(settings?)` | 本机会话列表，创建时间倒序 |
| `api.session(settings,id)` | 已保存 `Session` |
| `api.start(settings,caseId,selection?)` | 建立本机会话，固定病例版本、执行配置和研究快照 |
| `api.text(settings,id,text)` | 调用所选文本模型生成患者回答并保存实际轮次；问题长度1–3000字 |
| `api.end(settings,id)` | 结束问诊，状态进入 summary；语音活动由相应 owner 先结束 |
| `api.summary(settings,id,summary)` | 先保存独立总结，再调用所选文本模型生成并校验反馈 |
| `api.review(settings,id,reviewer,notes)` | 本机复核备注；原始模型预评不覆盖，已有复核进入历史记录 |
| `api.getDraft(id)` | `LearnerSummary | null` |
| `api.saveDraft(id,value|null)` | 保存草稿；null删除草稿 |
| `api.recordingBlob(id,role)` | 本机完整WAV `Blob`，role为learner或patient；不通过服务器fetch |
| `api.export(settings,id)` | v0.2 `BackupData`，包含该会话及所需关联登记；不是旧版单独Session导出 |
| `api.shareSession(id,{includeAudio})` | 原生ZIP生成/分享；浏览器返回JSON预览内容 |

```ts
interface LearnerSummary {
  history: string;
  reasoning: string;
  plan: string;
  uncertainty: string;
}
type SessionStatus =
  | 'interview' | 'summary' | 'feedback_pending'
  | 'feedback_ready' | 'reviewed';
```

文本/语音活动、结束、总结及反馈之间有本机状态门控。总结或模型失败保留已提交内容及错误；不会补入虚构成功反馈。并发反馈请求复用当前任务，原始自动评价尝试与接纳/拒绝状态保留，便于校准核对。

新训练保存冻结的执行配置。后续修改全局用途或模型不追溯修改旧会话；恢复旧会话仍受病例版本、原配置ID及当前原生Key授权域名是否匹配等条件约束。未具备执行条件的历史备份可回看，不能据此保证可续问。

配置删除保护覆盖interview和feedback_pending状态，以及summary状态下仍有可靠学员轮次、可生成反馈的会话。voice配置仅在未结束问诊使用时保护，待反馈保护针对text配置。

## 3. 语音与事件

`VoiceConnection` 在 `main.tsx` 通过 `configureVoiceServices(localService)` 连接本机业务服务。WebView用wavtools录播；原生网络桥负责授权HTTP与WebSocket。v0.2不向本机电脑发送旧版 `/api/voice` 首包。

- 千问输入为16kHz、OpenAI Realtime输入为24kHz，PCM16LE单声道；输出为24kHz。
- 网络握手、实时会话配置和应用ready是不同步骤。应用ready后才请求并启用麦克风。
- `speech_started` 触发清空当前播放缓冲；手动打断、迟到响应和过期回填按当前轮次处理。
- 语音层的 `lookup_patient_reply` 请求由所选文本模型结合固定病例生成患者可说内容，再交给语音层呈现。
- 输入与输出音量条来自实际音频；静音、未就绪与失败时不伪造活动。
- 离开、后台、结束或断开会释放本次媒体/连接；已确认转录保留，不自动重放未确认音频。

应用事件仍使用 `ServerEvent` 名称以复用现有语音层类型；这里表示本机适配器送给界面的事件，不表示存在电脑服务器。

| 事件 | 含义 |
|---|---|
| `ready` | 当前会话就绪，含sessionId/model及实际采样率 |
| `turn` | 新增或更新实际转录轮次 |
| `audio` | 当前患者PCM输出及itemId |
| `speech_started / speech_stopped` | 当前服务商的输入语音活动事件 |
| `response_started / response_done` | 当前语音响应状态；不单凭此标注已经播放 |
| `reasoning_started / reasoning_done` | 文本病例内核请求中/已结束 |
| `quality_warning` | 转述等质量问题；单独提示，不能误作网络断开 |
| `interrupted` | 当前回应被打断 |
| `session_ended` | 结束并返回已保存会话 |
| `error` | 具体操作失败；不填充成功轮次 |

转录可带 `verification:'matches_flash'|'paraphrase_unverified'`。不可靠、未确认或已打断片段不会被默认当作确定评分证据。文本内核原始回答、最终字幕、录音和质量提示为不同证据，均需按实际记录核对。

## 4. 科研登记与冻结快照

```ts
interface Study {
  id: string; code: string; title: string; ethicsId?: string;
  createdAt: string; updatedAt: string;
}
interface Participant {
  id: string; studyId: string; code: string;
  trainingYear?: string; rotationMonths?: number; group?: string;
  consent: 'not_recorded' | 'recorded' | 'not_applicable';
  note?: string; createdAt: string; updatedAt: string;
}
interface ResearchSelection {
  studyId?: string; participantId?: string;
  phase: 'baseline' | 'training' | 'post' | 'retention';
  mode: 'practice' | 'research';
}
```

| 调用 | 行为 |
|---|---|
| `api.studies()` / `api.participants(studyId?)` | 读取本机登记 |
| `api.saveStudy(input)` | code/title必填，id可选；新建生成ID和时间，更新保留createdAt |
| `api.saveParticipant(input)` | studyId/code/consent必填，id可选；校验项目存在 |
| `api.deleteParticipant(id)` | 仅未关联任何训练的登记可删除 |
| `api.researchExport({studyId?,includeAudio})` | 导出全部或指定项目的登记、会话、草稿及可选录音 |
| `api.importBackup(jsonString)` | JSON校验、关联核对、去重与恢复，返回新增/跳过统计 |

学员使用项目内编号，不以姓名作主键。项目代码在本机唯一，学员编号在相应项目内唯一；实际ID用于关联。组别为手工登记，App不执行随机分配。

`Session.research` 在开始时保存选择及项目/学员显示字段、组别、年级、轮转月数、同意状态、`capturedAt` 和 `attemptIndex`。后续登记更改不改旧快照。

当前 `attemptIndex` 按已有会话中同学员ID（未绑定练习为未绑定者）、同病例及同用途累计，不按phase重置；分析需保留phase与sessionId等关联键。时间戳来源为设备时钟。

`Session.runtime` 保存App/引擎/提示词/量规版本，以及文本与语音配置ID、公司、地址、模型和音色；不含Key。模型业务请求不主动加入项目或学员登记信息。

请求模型ID与接口返回模型名称的快照不代表服务商底层权重固定，不能单独作为模型版本稳定性证明。

当前不提供自动云同步。多手机应先导入同一份无会话的主登记备份，保留项目/学员UUID，采集端不分别修改登记，再导入各手机的新会话汇总。同编号不同UUID不自动认同；同ID内容不同整体拒绝，需人工核对。操作与边界见 [用户指南](USER_GUIDE.md#多手机采集与汇总)。

## 5. 反馈与人工复核

`Feedback.assessment` 保存量规ID、版本、改编标识、公开来源与限制；`scoreSummary` 按病例信息、可观察沟通过程分别给出：

```ts
{ group, label, score, maxScore, scoredItems, totalItems, coverage }
```

分母仅包含已评项目，每项最高2分；全部未计分时 `score=0,maxScore=0,scoredItems=0` 是数据表达，UI应显示“未能评分”，不能将其解释为0分表现。项目0分需明确不当行为及可靠原文依据；缺记录、不可观察、不适用为null。

完整类型预留教师逐项修正，并与原始预评分分开保存；当前界面与 `api.review` 只提交教师备注，不提供逐项改分。引用校验确认出处，并不验证教育解释或模型评分正确。具体已发现限制见 [ASSESSMENT_SPOTCHECK.md](ASSESSMENT_SPOTCHECK.md)。

## 6. 导出与恢复

```ts
interface BackupData {
  schemaVersion: '0.2';
  exportedAt: string;
  simulatedCases: true;
  studies: Study[];
  participants: Participant[];
  sessions: Session[];
  drafts?: Record<string,LearnerSummary>;
}
interface ExportResult {
  fileName: string; bytes: number;
  uri?: string; shared?: boolean; content?: string;
}
```

安卓返回生成的ZIP信息并尝试打开系统分享；`shared:true` 表示分享面板已启动，不证明接收应用已保存/发送。浏览器返回 `content` 为JSON备份，UI据此触发JSON下载；浏览器不生成音频ZIP。

ZIP内含 `backup.json`、`manifest.json`、CSV表、说明和 `recordings-manifest.json`，勾选后附实际存在的WAV。CSV表为studies、participants、sessions、turns、assessments、model_calls、teacher_reviews、feedback_attempts、audit_events。原始模型结果与教师记录分开；失败但已有原始返回的feedbackAttempts也保留raw与拒绝原因。CSV添加公式保护前缀，精确源文本以JSON为准。

录音为两路独立连续流，不承诺共同时间线同步；缺失文件在清单标明，不能生成替代音频。`sessions.csv` 的 `learner_recording_incomplete` / `patient_recording_incomplete` 由对应角色的 `recording_incomplete` 审计事件推导，原因保留在 `audit_events.csv`；false不构成完整录音证明。文件存在状态与保存不完整状态应分别核对。

JSON导入：

- 最大25MB，要求v0.2结构及正确关联；含密钥字段的输入拒绝。
- 只新增或跳过完全一致的数据；同ID不同内容、重复ID或登记关联冲突时拒绝，不覆盖原数据。
- 有当前训练/模型任务时须先结束或断开；写入中断保留恢复日志，重新初始化时处理。
- 返回 `{studies,participants,sessions,drafts,skipped}`。
- 只恢复文字/元数据；WAV留在原ZIP，Key与完整API配置需另行登记。
- 不自动转换v0.1电脑服务记录或旧版单会话JSON。详见 [STANDALONE_MIGRATION.md](STANDALONE_MIGRATION.md)。

## 7. 开发与验证边界

纯UI、登记、状态机、模拟传输、原生存储/网络、真实服务商接入与物理手机声学为不同验收层。App默认路径以最终APK哈希对应的v0.2收据为准。Legacy HTTP/MCP测试不能自动证明手机独立链路，软件验收也不能确立评分效度或教学效果。
