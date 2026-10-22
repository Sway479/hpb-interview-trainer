# Optional live-test audio

Historical synthetic speech files are omitted from the public distribution because
this publication review did not establish their redistribution provenance.
The ordinary Node unit tests do not require these files.

Before manually running scripts/verify-live.ts, create your own consented or
synthetic Chinese interview-question audio as interview-question-short.pcm:
raw signed little-endian PCM16, mono, 16 kHz. That script calls a paid provider.
Do not use patient recordings or assume the historical live test can be replayed
without a dedicated target, credentials, and separately authorized API use.
