"""Limit the final UI repair to web assets; retain the identity of the live-tested core APK."""
from pathlib import Path
import hashlib
import json
import re
import zipfile

root=Path(__file__).resolve().parents[1]
old=root/'artifacts/standalone/accepted-core/hpb-voice-standalone-core-accepted-debug.apk'
new=root/'artifacts/android/hpb-voice-standalone-debug.apk'
receipt={'scope':'accepted_core_to_final_ui_repair_apk_diff','acceptedCoreSha256':hashlib.sha256(old.read_bytes()).hexdigest(),
         'finalSha256':hashlib.sha256(new.read_bytes()).hexdigest()}
with zipfile.ZipFile(old) as before,zipfile.ZipFile(new) as after:
    old_hash={n:hashlib.sha256(before.read(n)).hexdigest() for n in before.namelist() if not n.endswith('/')}
    new_hash={n:hashlib.sha256(after.read(n)).hexdigest() for n in after.namelist() if not n.endswith('/')}
    changed=[n for n in sorted(set(old_hash)|set(new_hash)) if old_hash.get(n)!=new_hash.get(n)]
    native=[n for n in old_hash if re.fullmatch(r'classes\d*\.dex',n)]
    assert native and all(old_hash[n]==new_hash.get(n) for n in native),'native implementation changed after the paid flow'
    def chunk_key(name):
        return re.sub(r'-[A-Za-z0-9_-]{8}\.js$','.js',name)
    normalize=lambda text:re.sub(r'(index|p-[A-Za-z0-9_-]{8})-[A-Za-z0-9_-]{8}\.js',r'\1-HASH.js',text)
    old_chunks={chunk_key(n):n for n in old_hash if n.startswith('assets/public/assets/') and n.endswith('.js') and '/index-' not in n}
    new_chunks={chunk_key(n):n for n in new_hash if n.startswith('assets/public/assets/') and n.endswith('.js') and '/index-' not in n}
    assert set(old_chunks)==set(new_chunks),'non-entry JavaScript chunk set changed'
    assert all(normalize(before.read(old_chunks[k]).decode())==normalize(after.read(new_chunks[k]).decode()) for k in old_chunks),'non-entry JavaScript code changed beyond hashed import references'
    allowed=lambda n:n.startswith('META-INF/') or n=='assets/public/index.html' or bool(re.fullmatch(r'assets/public/assets/[\w-]+\.js',n))
    unexpected=[n for n in changed if not allowed(n)]
    receipt.update({'nativeDexFilesIdentical':native,'nonEntryJsUnchangedAfterHashedImportNormalization':len(old_chunks),'changedEntries':changed,'unexpectedChanges':unexpected,
                    'status':'passed' if not unexpected else 'failed'})
(root/'artifacts/standalone/final').mkdir(parents=True,exist_ok=True)
(root/'artifacts/standalone/final/accepted-core-apk-diff.json').write_text(json.dumps(receipt,indent=2),encoding='utf-8')
print(json.dumps(receipt,indent=2))
raise SystemExit(0 if receipt['status']=='passed' else 1)
