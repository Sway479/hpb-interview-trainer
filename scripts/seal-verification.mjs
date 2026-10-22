import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';

const json = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const identity = path => ({ path, bytes: statSync(path).size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
const apk = identity('artifacts/android/hpb-voice-prototype-debug.apk');
const source = identity('artifacts/hpb-voice-prototype-source-v0.1.0.zip');
const build = json('artifacts/android/build-receipt.json');
const native = json('artifacts/android/runtime-verification.json');
const media = json('artifacts/ui/browser-audio-e2e.json');
const ui = json('artifacts/ui/feedback-ui-verification-receipt.json');
const mcp = json('artifacts/mcp-verification.json');
const secrets = json('artifacts/delivery-secret-scan.json');
const audit = json('artifacts/production-audit.json');
const tests = readFileSync('artifacts/final-tests.txt', 'utf8');
assert.equal(build.sha256, apk.sha256);
assert.equal(native.apk.sha256, apk.sha256);
assert.equal(native.status, 'passed');
assert.equal(media.status, 'passed');
assert.equal(media.errors.length, 0);
assert.equal(media.assessment.version, '0.1');
assert.equal(ui.pageErrors.length, 0);
assert.equal(ui.evidenceJump, true);
assert.equal(ui.reviewSaved, true);
assert.equal(ui.allNullFixture.showsUnscoredTwice, true);
assert.equal(mcp.status, 'passed');
assert.equal(secrets.status, 'passed');
assert.equal(secrets.artifacts[apk.path].sha256, apk.sha256);
assert.equal(secrets.artifacts[source.path].sha256, source.sha256);
assert.equal(audit.metadata.vulnerabilities.total, 0);
assert.match(tests, /tests\s+41/);
assert.match(tests, /pass\s+41/);
assert.match(tests, /fail\s+0/);
const evidencePaths = [
  'artifacts/final-tests.txt', 'artifacts/final-typecheck.txt',
  'artifacts/android/build-receipt.json', 'artifacts/android/package-inspection.json',
  'artifacts/android/runtime-verification.json', 'artifacts/android/runtime-console.txt',
  'artifacts/ui/browser-audio-e2e.json', 'artifacts/ui/feedback-ui-verification-receipt.json',
  'artifacts/mcp-verification.json', 'artifacts/production-audit.json', 'artifacts/dependency-audit.json',
  'artifacts/delivery-secret-scan.json',
];
const receipt = { at: new Date().toISOString(), version: '0.1.0', scope: 'functional_android_teaching_prototype',
  status: 'accepted_for_prototype_delivery_with_stated_limits', artifacts: { apk, source },
  models: { voice: 'qwen-audio-3.1-realtime-plus', caseAndFeedback: 'qwen3.8-flash' },
  checks: { coreTests: { passed: 41, failed: 0 }, typecheck: 'passed',
    realBrowserMedia: { status: media.status, checks: media.checks.length, syntheticSpeech: true },
    finalFeedbackUi: 'passed', mcp: { status: mcp.status, tools: mcp.tools.length },
    finalApkWebAssets: build.packagedWebAssetsVerified, finalApkEmulatorMediaApis: native.status,
    exactCredentialScan: secrets.status, productionDependencyVulnerabilities: 0 },
  evidence: evidencePaths.map(identity),
  limits: [
    'Real phone speaker, echo control, headset/Bluetooth, hospital network and long-running sessions remain unverified.',
    'Case content and adapted formative assessment await teaching expert calibration. The real sample revealed possible semantic over-credit and unused evidence.',
    'Local teacher notes are a single-user prototype feature. They do not implement hospital identity or per-criterion grade revision.',
    'No educational efficacy, clinical competence or formal examination validity is established by these software tests.'
  ] };
writeFileSync('artifacts/final-verification.json', JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ status: receipt.status, artifacts: receipt.artifacts, checks: receipt.checks }, null, 2));
