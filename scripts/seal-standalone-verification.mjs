import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync,statSync,writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const json=path=>JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));
const identity=path=>({path,bytes:statSync(path).size,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')});
const apk=identity('artifacts/android/hpb-voice-standalone-debug.apk');
const deliverApk=identity('artifacts/v0.2.0/hpb-voice-standalone-v0.2.0-debug.apk');
const source=identity('artifacts/hpb-voice-standalone-source-v0.2.0.zip');
const acceptedCore=identity('artifacts/standalone/accepted-core/hpb-voice-standalone-core-accepted-debug.apk');
const build=json('artifacts/android/standalone-build-receipt.json'),inspection=json('artifacts/android/hpb-voice-standalone-debug.inspection.json');
const core=json('artifacts/standalone/android/standalone-android-verification.json'),final=json('artifacts/standalone/final/final-apk-verification.json');
const diff=json('artifacts/standalone/final/accepted-core-apk-diff.json'),exports=json('artifacts/standalone/research-export-verification.json');
const unit=json('artifacts/standalone/unit-verification.json'),secrets=json('artifacts/delivery-secret-scan-v0.2.0.json');
const tests=readFileSync('artifacts/standalone/tests.log','utf8');
assert.equal(apk.sha256,deliverApk.sha256);assert.equal(build.sha256,apk.sha256);assert.equal(inspection.sha256,apk.sha256);assert.equal(inspection.allChecksPassed,true);
assert.equal(final.apk.sha256,apk.sha256);assert.equal(final.status,'passed');assert.equal(final.pageErrors.length,0);
assert.equal(core.apk.sha256,acceptedCore.sha256);assert.equal(core.status,'passed');assert.equal(core.errors.length,0);
assert.equal(diff.acceptedCoreSha256,acceptedCore.sha256);assert.equal(diff.finalSha256,apk.sha256);assert.equal(diff.status,'passed');
assert.equal(exports.status,'passed');assert.equal(exports.sha256,core.export.sha256);
assert.ok(unit.checks.every(c=>c.status==='passed'));assert.match(tests,/tests\s+74/);assert.match(tests,/pass\s+74/);assert.match(tests,/fail\s+0/);
assert.equal(secrets.status,'passed');assert.equal(secrets.artifacts[apk.path].sha256,apk.sha256);assert.equal(secrets.artifacts[source.path].sha256,source.sha256);
assert.equal(secrets.artifacts['artifacts/standalone/android/native-research-export.zip'].sha256,exports.sha256);
const evidence=[
  'artifacts/android/standalone-build-receipt.json','artifacts/android/hpb-voice-standalone-debug.inspection.json',
  'artifacts/standalone/android/standalone-android-verification.json','artifacts/standalone/final/final-apk-verification.json',
  'artifacts/standalone/final/accepted-core-apk-diff.json','artifacts/standalone/research-export-verification.json',
  'artifacts/standalone/unit-verification.json','artifacts/standalone/tests.log','artifacts/standalone/typecheck.log',
  'artifacts/ui/standalone-v0.2/ui-standalone-verification.json','artifacts/delivery-secret-scan-v0.2.0.json',
];
const receipt={at:new Date().toISOString(),version:'0.2.0',status:'accepted_for_standalone_prototype_delivery_with_stated_limits',
  scope:'phone_direct_provider_profiles_local_research_registration_training_export_and_restore',
  sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),artifacts:{apk:deliverApk,source,acceptedCore},
  checks:{nodeTests:{passed:74,failed:0},typecheck:'passed',nativeOriginPolicyTests:8,nativeErrorClassificationTests:5,
    fullPaidQwenCoreFlow:{status:core.status,checks:core.checks.length,syntheticAudio:true},finalApkTargetedRuntime:{status:final.status,checks:final.checks.length},
    originalCoreNativeDexUnchanged:diff.nativeDexFilesIdentical.length,independentResearchExportChecks:exports.checks.length,exactCredentialScan:secrets.status},
  evidence:evidence.map(identity),limits:[
    'Only Qwen has actual credential/provider integration; other providers have implemented protocol tests only.',
    'No physical microphone/speaker/echo/Bluetooth or hospital-network validation; an earlier transient disconnection remains unexplained.',
    'Synthetic QA records establish software behavior only. Adapted scores still show semantic over-credit and unused evidence; teacher calibration is required.',
    'Local-only registration and file-based merging are implemented; no cloud synchronization, hospital role authentication or per-criterion teacher grading UI.',
    'JSON restores text/metadata, not WAV or credentials. Export ZIP is unencrypted and must be saved outside disposable app cache.',
  ]};
writeFileSync('artifacts/final-verification-v0.2.0.json',JSON.stringify(receipt,null,2));
console.log(JSON.stringify({status:receipt.status,artifacts:receipt.artifacts,checks:receipt.checks},null,2));
