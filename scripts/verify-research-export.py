"""Independently inspect the native ZIP from synthetic Android acceptance."""
from __future__ import annotations
import csv
import hashlib
import io
import json
import math
from pathlib import Path, PurePosixPath
import sys
import wave
import zipfile

root = Path(__file__).resolve().parents[1]
source = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'artifacts/standalone/android/native-research-export.zip'
output = root / 'artifacts/standalone/research-export-verification.json'
receipt = {'scope': 'independent_native_research_zip_validation', 'source': str(source), 'checks': [], 'wav': []}

def check(name: str):
    receipt['checks'].append(name)

try:
    receipt['sha256'] = hashlib.sha256(source.read_bytes()).hexdigest()
    with zipfile.ZipFile(source) as archive:
        names = archive.namelist()
        assert len(names) == len(set(names)), 'duplicate ZIP paths'
        assert archive.testzip() is None, 'ZIP CRC failure'
        assert all(not PurePosixPath(n).is_absolute() and '..' not in PurePosixPath(n).parts for n in names)
        assert not any(PurePosixPath(n).name.startswith('.env') for n in names)
        check('complete_zip_crc_unique_and_relative_paths_no_env_file')
        data = json.loads(archive.read('backup.json'))
        manifest = json.loads(archive.read('manifest.json'))
        audio_manifest = json.loads(archive.read('recordings-manifest.json'))
        assert data['schemaVersion'] == '0.2' and data['simulatedCases'] is True
        assert manifest['credentialExported'] is False
        studies = {s['id']: s for s in data['studies']}
        participants = {p['id']: p for p in data['participants']}
        sessions = {s['id']: s for s in data['sessions']}
        assert sessions and all(s['code'].startswith('SIMULATED_ONLY') for s in studies.values())
        for person in participants.values():
            assert person['studyId'] in studies
        for session in sessions.values():
            snapshot = session['research']
            assert snapshot['studyId'] in studies
            assert snapshot['participantId'] in participants
            assert participants[snapshot['participantId']]['studyId'] == snapshot['studyId']
            assert snapshot['group'].startswith('SIMULATED_ONLY') and snapshot['phase'] == 'baseline'
            assert session['runtime']['appVersion'] == '0.2.0'
            assert session['runtime']['text']['model'] == 'qwen3.8-flash'
            assert session['runtime']['voice']['protocol'] == 'qwen'
        check('project_participant_foreign_keys_and_frozen_research_runtime_snapshots')

        tables = {}
        for name in names:
            if name.endswith('.csv'):
                raw = archive.read(name)
                assert raw.startswith(b'\xef\xbb\xbf')
                tables[name] = list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'), newline='')))
        receipt['csvRows'] = {name: len(rows) for name, rows in tables.items()}
        assert {r['session_id'] for r in tables['sessions.csv']} == set(sessions)
        assert {r['id'] for r in tables['studies.csv']} == set(studies)
        assert {r['id'] for r in tables['participants.csv']} == set(participants)
        assert len(tables['turns.csv']) == sum(len(s['turns']) for s in sessions.values())
        assert len(tables['model_calls.csv']) == sum(len(s.get('modelCalls', [])) for s in sessions.values())
        assert len(tables['audit_events.csv']) == sum(len(s.get('auditEvents', [])) for s in sessions.values())
        assert len(tables['feedback_attempts.csv']) == sum(len(s.get('feedbackAttempts', [])) for s in sessions.values())
        check('csv_bom_and_all_table_counts_match_exact_json_backup')
        for session in sessions.values():
            feedback = session['feedback']
            assert session['status'] == 'reviewed' and session['review']['reviewer'] == 'SIMULATED_ONLY-T01'
            assert len(feedback['items']) == 12 and feedback['model'] == 'qwen3.8-flash'
            assert feedback['assessment']['adapted'] is True
            assert session['feedbackAttempts'][-1]['accepted'] is True
            assert session['feedbackAttempts'][-1]['raw']
            turns = {t['id']: t for t in session['turns']}
            for item in feedback['items']:
                for evidence in item['evidence']:
                    turn = turns[evidence['turnId']]
                    assert turn['role'] == 'learner' and turn['final'] and not turn.get('interrupted')
                    assert evidence['quote'] in turn['text']
                rows = [r for r in tables['assessments.csv'] if r['session_id'] == session['id'] and r['criterion_id'] == item['criterionId']]
                assert len(rows) == 1
                assert rows[0]['score'] == ('' if item.get('score') is None else str(item['score']))
                assert rows[0]['grading_origin'] == 'original_model_preassessment'
            for group, summary in feedback['scoreSummary'].items():
                members = [i for i in feedback['items'] if i['group'] == group]
                scored = [i for i in members if i.get('score') is not None]
                assert summary['score'] == sum(i['score'] for i in scored)
                assert summary['maxScore'] == 2 * len(scored)
                assert summary['scoredItems'] == len(scored)
                assert math.isclose(summary['coverage'], len(scored) / len(members), abs_tol=1e-9)
            reviews = [r for r in tables['teacher_reviews.csv'] if r['session_id'] == session['id']]
            assert reviews and reviews[-1]['reviewer_code'] == session['review']['reviewer']
        check('twelve_original_scores_recompute_with_unscored_denominators_and_exact_learner_quotes')
        check('raw_model_attempts_and_teacher_notes_remain_separate')

        # The native manifest may be an array or an object with an entries array.
        entries = audio_manifest if isinstance(audio_manifest, list) else audio_manifest.get('entries', audio_manifest.get('recordings', []))
        assert len(entries) == 2 * len(sessions), 'both role streams must have explicit manifest entries'
        for entry in entries:
            assert entry['sessionId'] in sessions and entry['role'] in ('learner', 'patient')
            assert entry['status'] == 'included', 'this acceptance requires both real received/captured streams'
            raw = archive.read(entry['path'])
            with wave.open(io.BytesIO(raw), 'rb') as wav:
                expected = 16000 if entry['role'] == 'learner' else 24000
                assert wav.getframerate() == expected == entry['sampleRate']
                assert wav.getnchannels() == 1 and wav.getsampwidth() == 2 and wav.getnframes() > 0
                receipt['wav'].append({'sessionId': entry['sessionId'], 'role': entry['role'], 'rate': expected,
                                       'seconds': wav.getnframes() / expected, 'bytes': len(raw)})
        check('both_role_wav_headers_rates_frames_and_native_recording_manifest_match')
        receipt['entries'] = len(names)
        receipt['sessionIds'] = list(sessions)
        receipt['status'] = 'passed'
except Exception as error:
    receipt['status'] = 'failed'
    receipt['error'] = str(error)
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(receipt, ensure_ascii=False, indent=2))
raise SystemExit(0 if receipt['status'] == 'passed' else 1)
