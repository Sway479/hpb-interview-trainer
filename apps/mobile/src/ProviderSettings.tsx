import { useEffect, useState, type FormEvent } from 'react';
import { IonIcon, IonSpinner } from '@ionic/react';
import { Capacitor } from '@capacitor/core';
import { addOutline, checkmarkCircle, chevronForwardOutline, eyeOffOutline, eyeOutline, flaskOutline, keyOutline, micOutline, pencilOutline, shieldCheckmarkOutline, trashOutline } from 'ionicons/icons';
import type { ConnectionSettings, ProviderProfile } from './platform/contracts';
import { defaultSettings } from './platform/settings';
import { Badge, EmptyState, Modal, Notice } from './components';
import './ProviderSettings.css';

export interface UIProbeResult { ok: boolean; message: string; model?: string }
interface Props {
  settings: ConnectionSettings;
  credentials: Record<string, { hasKey: boolean }>;
  onSaveProfile: (profile: ProviderProfile, key?: string) => Promise<void>;
  onDeleteProfile: (id: string) => Promise<void>;
  onSaveSelection: (settings: ConnectionSettings) => Promise<void>;
  onProbe: (settings: ConnectionSettings, capability: 'text' | 'voice') => Promise<UIProbeResult>;
}
const companies: { id: ProviderProfile['company']; label: string }[] = [
  { id: 'qwen', label: '千问 Qwen' }, { id: 'openai', label: 'OpenAI' }, { id: 'deepseek', label: 'DeepSeek（仅文本）' }, { id: 'custom', label: '自定义兼容接口' },
];
const companyLabel = (company: ProviderProfile['company']) => companies.find((item) => item.id === company)?.label || company;
const messageOf = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。';
function endpointDomains(profile: ProviderProfile) {
  return [profile.chatUrl, profile.realtimeProtocol === 'none' ? '' : profile.realtimeUrl].filter(Boolean).map((value) => {
    try { const url = new URL(value); return url.hostname.toLowerCase() + ':' + url.port; } catch { return value.trim(); }
  }).sort().join('|');
}
function preset(company: ProviderProfile['company'], existing: ProviderProfile[], id?: string): ProviderProfile {
  const identity = id || 'profile-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const prior = existing.find((profile) => profile.company === company) || defaultSettings().profiles.find((profile) => profile.company === company);
  if (prior) return { ...prior, id: identity, name: companyLabel(company) + ' 配置' };
  const common = { id: identity, name: companyLabel(company) + ' 配置', company, voice: '' };
  if (company === 'qwen') return { ...common, chatUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', chatModel: 'qwen3.8-flash', realtimeProtocol: 'qwen', realtimeUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime', realtimeModel: 'qwen-audio-3.1-realtime-plus', voice: 'Cherry' };
  if (company === 'openai') return { ...common, chatUrl: 'https://api.openai.com/v1', chatModel: '', realtimeProtocol: 'openai', realtimeUrl: 'wss://api.openai.com/v1/realtime', realtimeModel: '' };
  if (company === 'deepseek') return { ...common, chatUrl: 'https://api.deepseek.com', chatModel: 'deepseek-chat', realtimeProtocol: 'none', realtimeUrl: '', realtimeModel: '' };
  return { ...common, chatUrl: '', chatModel: '', realtimeProtocol: 'none', realtimeUrl: '', realtimeModel: '' };
}
export function ProviderSettings({ settings, credentials, onSaveProfile, onDeleteProfile, onSaveSelection, onProbe }: Props) {
  const [selection, setSelection] = useState(settings);
  const [section, setSection] = useState<'models' | 'providers'>('models');
  const [editing, setEditing] = useState<ProviderProfile | null>(null);
  const [original, setOriginal] = useState<ProviderProfile | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ProviderProfile | null>(null);
  const [probes, setProbes] = useState<Partial<Record<'text' | 'voice', UIProbeResult>>>({});
  useEffect(() => { setSelection(settings); }, [settings]);
  const changedDomain = !!editing && !!original && (editing.company !== original.company || endpointDomains(editing) !== endpointDomains(original));
  const native = Capacitor.isNativePlatform();
  const needsKey = !!editing && !!credentials[editing.id]?.hasKey && changedDomain;
  function closeEditor() { setEditing(null); setOriginal(null); setKeyInput(''); setShowKey(false); setError(''); }
  function edit(profile?: ProviderProfile) {
    setOriginal(profile ? { ...profile } : null);
    setEditing(profile ? { ...profile } : preset('qwen', settings.profiles));
    setKeyInput(''); setShowKey(false); setError(''); setNotice('');
  }
  function changeProfile(patch: Partial<ProviderProfile>) {
    if (!editing) return;
    const next = { ...editing, ...patch };
    if (endpointDomains(next) !== endpointDomains(editing) || next.company !== editing.company) { setKeyInput(''); setShowKey(false); }
    setEditing(next);
  }
  async function saveProfile(event: FormEvent) {
    event.preventDefault(); if (!editing || busy) return;
    if (needsKey && !keyInput.trim()) { setError(changedDomain ? '接口域名已改变，请重新填写用于新地址的 API Key。' : '请填写此配置的 API Key。'); return; }
    setBusy('profile'); setError('');
    try { await onSaveProfile(editing, keyInput.trim() || undefined); closeEditor(); setNotice('API 配置已保存。密钥不会在界面中回显。'); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(''); }
  }
  async function saveSelection(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy('selection'); setError(''); setNotice('');
    try { await onSaveSelection(selection); setNotice('文本与语音用途选择已保存。'); setProbes({}); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(''); }
  }
  async function probe(capability: 'text' | 'voice') {
    if (busy) return;
    setBusy(capability); setError('');
    try { const result = await onProbe(selection, capability); setProbes((previous) => ({ ...previous, [capability]: result })); }
    catch (cause) { setProbes((previous) => ({ ...previous, [capability]: { ok: false, message: messageOf(cause) } })); }
    finally { setBusy(''); }
  }
  async function remove() {
    if (!deleteTarget || busy) return;
    setBusy('delete'); setError('');
    try { await onDeleteProfile(deleteTarget.id); setDeleteTarget(null); setNotice('配置与对应的本机密钥已删除。'); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(''); }
  }
  const voiceProfiles = settings.profiles.filter((profile) => profile.company !== 'deepseek' && profile.realtimeProtocol !== 'none' && profile.realtimeUrl && profile.realtimeModel);
  const textChoice = settings.profiles.find((profile) => profile.id === selection.textProfileId);
  const voiceChoice = voiceProfiles.find((profile) => profile.id === selection.voiceProfileId);
  const selectionChanged = selection.textProfileId !== settings.textProfileId || selection.voiceProfileId !== settings.voiceProfileId;
  function keyStatus(profile: ProviderProfile) {
    return <Badge tone={credentials[profile.id]?.hasKey ? 'teal' : credentials[profile.id] ? 'amber' : 'neutral'} icon={keyOutline}>{credentials[profile.id]?.hasKey ? 'Key 已保存' : credentials[profile.id] ? '未设置 Key' : 'Key 状态待确认'}</Badge>;
  }
  return <main className="page-pad provider-settings">
    <header className="provider-page-heading"><h1 className="page-title">连接设置</h1><p>选择新训练使用的模型，管理服务商配置。</p></header>
    {!editing && error && <Notice tone="error">{error}</Notice>}{notice && <Notice tone="success">{notice}</Notice>}
    <div className="provider-tabs" role="group" aria-label="连接设置分区">
      <button type="button" className={section === 'models' ? 'selected' : ''} aria-pressed={section === 'models'} aria-controls="provider-models-section" onClick={() => setSection('models')}>本次模型</button>
      <button type="button" className={section === 'providers' ? 'selected' : ''} aria-pressed={section === 'providers'} aria-controls="provider-management-section" onClick={() => setSection('providers')}>服务商管理</button>
    </div>
    {section === 'models' && <section id="provider-models-section" aria-label="本次模型">
      <form onSubmit={(event) => void saveSelection(event)}><section className="panel purpose-panel"><h2>问诊使用的模型</h2>
        <div className="field"><label htmlFor="text-provider"><IonIcon icon={flaskOutline} />病例与反馈模型</label><select id="text-provider" value={selection.textProfileId || ''} onChange={(event) => { setSelection({ ...selection, textProfileId: event.target.value }); setProbes({}); }}><option value="">请选择文本 API 配置</option>{settings.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.chatModel || '未设模型'}</option>)}</select>
          {textChoice && <div className="provider-selection-detail"><div><strong>{textChoice.name}</strong>{keyStatus(textChoice)}</div><span>{companyLabel(textChoice.company)} · {textChoice.chatModel || '尚未设置文本模型'}</span></div>}
        </div>
        <div className="field"><label htmlFor="voice-provider"><IonIcon icon={micOutline} />实时语音模型</label><select id="voice-provider" value={selection.voiceProfileId || ''} onChange={(event) => { setSelection({ ...selection, voiceProfileId: event.target.value }); setProbes({}); }}><option value="">仅使用文字问诊</option>{voiceProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.realtimeModel}</option>)}</select>
          {voiceChoice ? <div className="provider-selection-detail"><div><strong>{voiceChoice.name}</strong>{keyStatus(voiceChoice)}</div><span>{companyLabel(voiceChoice.company)} · {voiceChoice.realtimeModel}</span></div> : <p>未选择语音配置时使用文字问诊。</p>}
          <p>实时配置需有协议、地址与模型；DeepSeek 仅文本。</p>
        </div>
        <p className={'provider-selection-note' + (selectionChanged ? ' pending' : '')} role="status">{selectionChanged ? '用途选择尚未保存；保存后用于新训练。' : 'Key 已保存仅表示凭证存在，不代表连接已检测。'}</p>
        <button className="primary-button full" type="submit" disabled={Boolean(busy)}>{busy === 'selection' ? <IonSpinner name="crescent" /> : <IonIcon icon={checkmarkCircle} />}保存用途选择</button>
        {!settings.profiles.length && <button type="button" className="text-button full" onClick={() => setSection('providers')}>先添加服务商配置</button>}
      </section></form>
    </section>}
    {section === 'providers' && <section id="provider-management-section" aria-label="服务商管理">
      <div className="section-heading"><h2>服务商配置</h2><button className="text-button" onClick={() => edit()}><IonIcon icon={addOutline} />添加配置</button></div>
      <p className="provider-management-note">保存配置后，在“本次模型”选择用途。Key 状态不代表连接结果。</p>
      {!settings.profiles.length ? <EmptyState icon={keyOutline} title="先添加一个 API 配置" action={<button className="primary-button full" onClick={() => edit()}>添加配置</button>}>新问诊需要可用配置；登记与已存记录可离线使用。</EmptyState> : <div className="provider-list">{settings.profiles.map((profile) => <section className="provider-card" key={profile.id}>
        <div className="provider-card-heading"><div><strong>{profile.name}</strong><span>{companyLabel(profile.company)}</span></div>{keyStatus(profile)}</div>
        <p className="provider-model">{profile.chatModel || '尚未设置文本模型'}</p>
        {(settings.textProfileId === profile.id || settings.voiceProfileId === profile.id) && <p className="provider-current-use">当前用于：{[settings.textProfileId === profile.id ? '病例与反馈' : '', settings.voiceProfileId === profile.id ? '实时语音' : ''].filter(Boolean).join('、')}</p>}
        <div className="provider-card-bottom"><Badge>{profile.realtimeProtocol === 'none' ? '仅文本' : profile.realtimeProtocol === 'qwen' ? '千问实时协议' : 'OpenAI 实时协议'}</Badge><div><button className="icon-button" aria-label={'编辑 ' + profile.name} onClick={() => edit(profile)}><IonIcon icon={pencilOutline} /></button><button className="icon-button danger-quiet" aria-label={'删除 ' + profile.name} onClick={() => setDeleteTarget(profile)}><IonIcon icon={trashOutline} /></button></div></div>
      </section>)}</div>}
    </section>}
    <details className="provider-disclosure provider-probes"><summary><span>连接检测</span><small>会产生 API 用量</small></summary><div className="provider-disclosure-body">
      <p>点击检测才会向所选 API 发起请求。保存配置或 Key 不等于连接已验证。</p>
      <div className="settings-actions"><button className="secondary-button" onClick={() => void probe('text')} disabled={Boolean(busy) || !selection.textProfileId || !credentials[selection.textProfileId]?.hasKey}>{busy === 'text' ? <IonSpinner name="crescent" /> : <IonIcon icon={flaskOutline} />}检测文本</button><button className="secondary-button" onClick={() => void probe('voice')} disabled={Boolean(busy) || !selection.voiceProfileId || !credentials[selection.voiceProfileId]?.hasKey}>{busy === 'voice' ? <IonSpinner name="crescent" /> : <IonIcon icon={micOutline} />}检测语音</button></div>
      {(['text', 'voice'] as const).map((capability) => probes[capability] && <Notice key={capability} tone={probes[capability]?.ok ? 'success' : 'error'}><strong>{capability === 'text' ? '文本' : '语音'}：{probes[capability]?.ok ? '检测通过' : '未通过'}</strong><p>{probes[capability]?.message}</p>{probes[capability]?.model && <small>{probes[capability]?.model}</small>}</Notice>)}
    </div></details>
    <p className="provider-data-note">问诊发送至所选 API；登记与记录保存在本机。</p>
    <details className="provider-disclosure provider-data-details"><summary><IonIcon icon={shieldCheckmarkOutline} /><span>数据与密钥说明</span></summary><div className="provider-disclosure-body">
      <p>仅使用虚构病例与学员编号，勿输入真实身份资料。</p><p>API Key 仅在安卓 App 保存；界面只显示是否存在，不回显已保存内容。更换接口域名须重新填写 Key。</p><p>自定义兼容接口仍需实际协议、模型与音色匹配。</p>
    </div></details>
    {editing && <Modal title={original ? '编辑 API 配置' : '添加 API 配置'} onClose={closeEditor}><form onSubmit={(event) => void saveProfile(event)}>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="field"><label htmlFor="provider-company">服务商</label><select id="provider-company" value={editing.company} onChange={(event) => { const company = event.target.value as ProviderProfile['company']; changeProfile(preset(company, settings.profiles, editing.id)); }}>{companies.map((company) => <option key={company.id} value={company.id}>{company.label}</option>)}</select></div>
      <div className="field"><label htmlFor="provider-name">配置名称</label><input id="provider-name" value={editing.name} onChange={(event) => changeProfile({ name: event.target.value })} placeholder="如：千问教学账号" maxLength={80} required /></div>
      <div className="provider-form-section"><h3>密钥</h3>{changedDomain && <Notice>接口域名或服务商已改变，请为新地址重新填写 Key；已保存的密钥不会自动沿用。</Notice>}{!native && <Notice>浏览器预览只保存非敏感配置，请在安卓 App 中填写并安全保存 API Key。</Notice>}<div className="field"><label htmlFor="provider-key">API Key {credentials[editing.id]?.hasKey && !changedDomain && <Badge tone="teal">已保存</Badge>}</label><div className="password-input"><input id="provider-key" type={showKey ? 'text' : 'password'} value={keyInput} onChange={(event) => setKeyInput(event.target.value)} autoComplete="new-password" autoCapitalize="off" spellCheck={false} placeholder={needsKey ? '为新域名重新填写 API Key' : credentials[editing.id]?.hasKey ? '留空保留已保存的 Key' : '可稍后在安卓 App 中填写'} required={needsKey} disabled={!native} /><button type="button" className="icon-button" disabled={!native} aria-label={showKey ? '隐藏新填写的 Key' : '显示新填写的 Key'} onClick={() => setShowKey(!showKey)}><IonIcon icon={showKey ? eyeOffOutline : eyeOutline} /></button></div><p>可先只保存配置。密钥仅在安卓 App 内保存；保存后清空输入框，不回显已保存内容。</p></div></div>
      <div className="provider-form-section"><h3>文本接口</h3><div className="field"><label htmlFor="chat-url">兼容接口地址</label><input id="chat-url" type="url" autoCapitalize="off" autoComplete="off" spellCheck={false} value={editing.chatUrl} onChange={(event) => changeProfile({ chatUrl: event.target.value })} placeholder="https://api.example.com/v1" required /></div><div className="field"><label htmlFor="chat-model">文本模型 ID</label><input id="chat-model" value={editing.chatModel} onChange={(event) => changeProfile({ chatModel: event.target.value })} placeholder="填写账号可用的模型 ID" autoCapitalize="off" spellCheck={false} required /></div></div>
      <div className="provider-form-section"><h3>实时语音接口</h3><div className="field"><label htmlFor="realtime-protocol">实时协议</label><select id="realtime-protocol" value={editing.realtimeProtocol} disabled={editing.company === 'deepseek'} onChange={(event) => changeProfile({ realtimeProtocol: event.target.value as ProviderProfile['realtimeProtocol'] })}><option value="none">无实时接口 · 仅文本</option><option value="qwen">千问 Realtime</option><option value="openai">OpenAI Realtime</option></select><p>Chat Completions 兼容不代表实时语音协议兼容。</p></div>{editing.realtimeProtocol !== 'none' && <><div className="field"><label htmlFor="realtime-url">实时 WebSocket 地址</label><input id="realtime-url" type="url" value={editing.realtimeUrl} onChange={(event) => changeProfile({ realtimeUrl: event.target.value })} placeholder="wss://..." autoCapitalize="off" spellCheck={false} required /></div><div className="field"><label htmlFor="realtime-model">语音模型 ID</label><input id="realtime-model" value={editing.realtimeModel} onChange={(event) => changeProfile({ realtimeModel: event.target.value })} autoCapitalize="off" spellCheck={false} required /></div><div className="field"><label htmlFor="provider-voice">音色 ID</label><input id="provider-voice" value={editing.voice || ''} onChange={(event) => changeProfile({ voice: event.target.value })} placeholder="填写服务商支持的音色 ID" autoCapitalize="off" spellCheck={false} required /></div></>}</div>
      <button className="primary-button full" type="submit" disabled={Boolean(busy)}>{busy === 'profile' ? <IonSpinner name="crescent" /> : <IonIcon icon={keyOutline} />}保存 API 配置</button>
    </form></Modal>}
    {deleteTarget && <Modal title="删除此 API 配置？" onClose={() => setDeleteTarget(null)}><p>将删除“{deleteTarget.name}”及其本机密钥。已有训练记录会保留。</p>{error && <Notice tone="error">{error}</Notice>}<div className="dialog-actions"><button className="secondary-button" onClick={() => setDeleteTarget(null)}>取消</button><button className="primary-button danger-button" onClick={() => void remove()} disabled={Boolean(busy)}>确认删除</button></div></Modal>}
  </main>;
}

