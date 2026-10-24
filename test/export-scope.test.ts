import test from 'node:test';
import assert from 'node:assert/strict';
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { Session } from '../packages/core/src/types.ts';

const exportedPackages: { textFiles: { path: string; content: string }[] }[] = [];
const nativeCalls: string[] = [];
// Only local export/share methods are stubbed. Any model or credential method
// reaching this test bridge fails before it can perform I/O.
registerPlugin('HpbNative', { web: {
  async exportPackage(options: { fileName: string; textFiles: { path: string; content: string }[] }) {
    nativeCalls.push('exportPackage'); exportedPackages.push(options);
    return { uri: 'content://SIMULATED_ONLY/export', fileName: options.fileName, bytes: 123 };
  },
  async sharePackage() { nativeCalls.push('sharePackage'); },
  async credentialStatus() { throw new Error('credential reads are forbidden in export scope tests'); },
  async http() { throw new Error('model requests are forbidden in export scope tests'); },
  async openSocket() { throw new Error('model requests are forbidden in export scope tests'); },
} });
const exportModule = new URL('../apps/mobile/src/platform/export-data.ts', import.meta.url).href;
const apiModule = new URL('../apps/mobile/src/api.ts', import.meta.url).href;
const serviceModule = new URL('../apps/mobile/src/platform/local-service.ts', import.meta.url).href;
const { researchFiles } = await import(exportModule);
const { api } = await import(apiModule);
const { localService } = await import(serviceModule);
const at = '2026-10-23T00:00:00.000Z';
const studyId = 'a5cb4529-b2a5-4e0b-b802-6818e6d54300';
const sessionId = '255522dc-c713-4f55-875e-629b973a75dd';
const warnings = [
  { path: 'sessions/OTHER_PRIVATE_PROJECT.json', message: 'OTHER_PROJECT_PRIVATE_MESSAGE', raw: 'OTHER_PROJECT_PRIVATE_RAW' },
  { path: 'drafts/OTHER_PRIVATE_DRAFT.json', message: 'SIMULATED_ONLY empty damaged draft', raw: '' },
  { path: 'participants/UNREADABLE_PRIVATE_PATH.json', message: 'SIMULATED_ONLY read failed' },
];
function session(mode?: 'automatic' | 'manual'): Session {
  return { id: sessionId, caseId: 'ruq-01', caseVersion: '0.1', caseTitle: 'SIMULATED_ONLY', createdAt: at,
    status: 'summary', turns: [], runtime: { appVersion: '0.3.1', engineVersion: 'SIMULATED_ONLY',
      patientPromptVersion: 'SIMULATED_ONLY', feedbackPromptVersion: 'SIMULATED_ONLY', assessmentId: 'SIMULATED_ONLY', assessmentVersion: '0.1',
      ...(mode ? { feedbackGeneration: mode } : {}), text: { profileId: 'SIMULATED_ONLY', company: 'qwen', endpoint: 'https://example.invalid', model: 'SIMULATED_ONLY' } } };
}
function backup(sessions: Session[] = []) {
  return { schemaVersion: '0.2', exportedAt: at, simulatedCases: true, studies: [], participants: [], sessions, drafts: {} };
}
const content = (files: { path: string; content: string }[], path: string) => {
  const match = files.find(file => file.path === path); assert.ok(match, path); return match.content;
};
function csvRows(csv: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false;
  csv = csv.replace(/^\uFEFF/, '');
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index];
    if (char === '"') { if (quoted && csv[index + 1] === '"') { field += '"'; index++; } else quoted = !quoted; }
    else if (!quoted && char === ',') { row.push(field); field = ''; }
    else if (!quoted && (char === '\r' || char === '\n')) { if (char === '\r' && csv[index + 1] === '\n') index++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  assert.equal(quoted, false); return rows;
}

test('all-device export retains recovery originals, marks incomplete backup, and preserves exact readable source', () => {
  const source = backup([session('manual')]), before = JSON.stringify(source);
  const files = researchFiles(source, false, warnings);
  assert.equal(content(files, 'backup.json'), JSON.stringify(source, null, 2));
  assert.equal(content(files, 'recovery/record-1.txt'), warnings[0].raw);
  assert.equal(content(files, 'recovery/record-2.txt'), '', 'an empty damaged file is still retained');
  const manifest = JSON.parse(content(files, 'manifest.json'));
  assert.deepEqual(manifest.warnings, warnings.map(({ path, message }) => ({ path, message })));
  assert.equal(manifest.recovery.scope, 'all'); assert.equal(manifest.recovery.warningCount, 3); assert.equal(manifest.recovery.rawRecoveryCount, 2);
  assert.match(content(files, 'README.txt'), /不能把本次导出视为完整备份/);
  assert.equal(JSON.stringify(source), before, 'export does not rewrite readable source');
});

for (const scope of ['study', 'session'] as const) {
  test(`${scope} export exposes only a local anomaly count, without unrelated raw text, paths or messages`, () => {
    const source = backup([session('manual')]), files = researchFiles(source, false, warnings, scope);
    assert.equal(content(files, 'backup.json'), JSON.stringify(source, null, 2));
    assert.equal(files.some((file: { path: string }) => file.path.startsWith('recovery/')), false);
    const completePackage = JSON.stringify(files);
    for (const warning of warnings) {
      assert.equal(completePackage.includes(warning.path), false);
      assert.equal(completePackage.includes(warning.message), false);
      if (warning.raw) assert.equal(completePackage.includes(warning.raw), false);
    }
    const manifest = JSON.parse(content(files, 'manifest.json'));
    assert.equal(manifest.recovery.scope, scope); assert.equal(manifest.recovery.warningCount, 3); assert.equal(manifest.recovery.rawRecoveryCount, 0);
    assert.equal('path' in manifest.warnings[0], false);
    assert.match(manifest.warnings[0].message, /另有3条本机异常资料/);
    assert.match(content(files, 'README.txt'), /本机全部资料/);
  });
}

test('CSV records frozen generation modes and leaves legacy missing values empty', () => {
  const manual = session('manual'), automatic = { ...session('automatic'), id: '113890c3-8df5-4c34-b9e2-b8f4431b9686' }, legacy = { ...session(), id: 'c09fe9ae-7da7-4b8a-8a01-9472a07f8caf' };
  const source = backup([manual, automatic, legacy]), before = JSON.stringify(source);
  const [headers, ...rows] = csvRows(content(researchFiles(source, false), 'sessions.csv'));
  const column = headers.indexOf('feedback_generation'); assert.ok(column >= 0);
  assert.deepEqual(rows.map(row => row[column]), ['manual', 'automatic', '']);
  assert.equal(JSON.stringify(source), before);
});

test('dataWarnings awaits initialization, returns detached metadata only, and needs no health or credential check', async () => {
  const repository = localService.repository, originalInitialize = repository.initialize;
  const previousWarnings = [...repository.warnings], originalHealth = api.health;
  let release!: () => void, resolved = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  repository.warnings.splice(0, repository.warnings.length, ...warnings);
  repository.initialize = async () => { await gate; };
  api.health = async () => { throw new Error('health must not be used for local warnings'); };
  try {
    const pending = api.dataWarnings().then((value: unknown) => { resolved = true; return value; });
    await Promise.resolve(); assert.equal(resolved, false); release();
    const result = await pending;
    assert.deepEqual(result, warnings.map(({ path, message, raw }) => ({ path, message, hasRecoveryText: raw !== undefined })));
    assert.equal(JSON.stringify(result).includes('OTHER_PROJECT_PRIVATE_RAW'), false);
    (result as { message: string }[])[0].message = 'local returned edit';
    assert.equal(repository.warnings[0].message, warnings[0].message);
  } finally { repository.initialize = originalInitialize; api.health = originalHealth; repository.warnings.splice(0, repository.warnings.length, ...previousWarnings); }
});

test('API sends explicit study/session/all scope to native packages and reports the recovery gap', async () => {
  const repository = localService.repository, originalBackup = repository.backup, previousWarnings = [...repository.warnings];
  const originalNative = Capacitor.isNativePlatform, source = backup([session('manual')]);
  const backupCalls: unknown[][] = [];
  repository.backup = async (...args: unknown[]) => { backupCalls.push(args); return source; };
  repository.warnings.splice(0, repository.warnings.length, ...warnings);
  Capacitor.isNativePlatform = () => true;
  exportedPackages.length = 0; nativeCalls.length = 0;
  try {
    const projectResult = await api.researchExport({ studyId, includeAudio: false });
    const sessionResult = await api.shareSession(sessionId, { includeAudio: false });
    const allResult = await api.researchExport({ includeAudio: false });
    assert.deepEqual(backupCalls, [[studyId, undefined], [undefined, sessionId], [undefined, undefined]]);
    assert.deepEqual(exportedPackages.map(value => JSON.parse(content(value.textFiles, 'manifest.json')).recovery.scope), ['study', 'session', 'all']);
    assert.equal(JSON.stringify(exportedPackages.slice(0, 2)).includes('OTHER_PROJECT_PRIVATE_RAW'), false);
    assert.equal(content(exportedPackages[2].textFiles, 'recovery/record-1.txt'), 'OTHER_PROJECT_PRIVATE_RAW');
    for (const result of [projectResult, sessionResult, allResult]) { assert.equal(result.dataWarningCount, 3); assert.ok(result.recoveryNotice); }
    assert.match(projectResult.recoveryNotice, /另有3条/); assert.match(allResult.recoveryNotice, /不能把本次导出视为完整备份/);
    assert.deepEqual(nativeCalls, ['exportPackage', 'sharePackage', 'exportPackage', 'sharePackage', 'exportPackage', 'sharePackage']);
  } finally { repository.backup = originalBackup; Capacitor.isNativePlatform = originalNative; repository.warnings.splice(0, repository.warnings.length, ...previousWarnings); }
});

test('browser JSON export reports that damaged-record recovery text is absent', async () => {
  const repository = localService.repository, originalBackup = repository.backup, previousWarnings = [...repository.warnings];
  const originalNative = Capacitor.isNativePlatform;
  repository.backup = async () => backup(); repository.warnings.splice(0, repository.warnings.length, ...warnings); Capacitor.isNativePlatform = () => false;
  try {
    const result = await api.researchExport({ includeAudio: false });
    assert.equal(result.dataWarningCount, 3); assert.match(result.recoveryNotice, /浏览器JSON只含可读取记录，不含异常原文/);
    assert.equal(result.content.includes('OTHER_PROJECT_PRIVATE_RAW'), false);
    assert.equal(result.bytes, new Blob([result.content]).size, 'reported size covers the exact downloaded JSON bytes');
  } finally { repository.backup = originalBackup; Capacitor.isNativePlatform = originalNative; repository.warnings.splice(0, repository.warnings.length, ...previousWarnings); }
});
