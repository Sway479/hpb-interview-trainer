# Public source provenance

Published 2026-10-22 as v0.2.0-alpha.1 from private development revision
`4159a39c9bb7877af7465b9ab878d8afff1bc522` (Android App version 0.2.0).

This is a new public Git history. The original three-commit development history,
archived deliveries, grant materials and verification files remain preserved
locally. Old developer identities and workstation paths are not published as
commit history. The public repository contains software source and selected
fictional emulator screenshots, not the complete private migration archive.

For the initial v0.2.0-alpha.1 snapshot, publication changes were limited to licensing/package license metadata, ignore
rules, a newly authored configuration example with empty credentials, public
documentation, removal of workstation-specific prose and omitted
private/optional materials. In that initial snapshot, application, native bridge, domain, test source and
build implementation are unchanged from the revision above. Dependency versions
and integrity values are unchanged. New screenshots show the existing APK,
not a modified application.

Excluded material includes the grant workspace/notices/templates, migration
handoff records, proposal rebuilding tools that require private archived inputs,
concept art and exploratory research notes, original synthetic speech binaries
whose redistribution provenance was not established in this review, raw model
responses/recordings/research exports, local credentials/signing keys, installed
dependencies, SDKs, caches and machine logs. No patient or recruited learner data
is included. Optional live-test audio requirements are documented under
`test/fixtures/README.md`.

The three published screenshots are from a dedicated Android 14 emulator on
2026-10-22. Project/learner identifiers are fictional SIMULATED_ONLY QA labels.
The current offline inspection did not call a model API. Historical live-Qwen
results are identified as historical in [OPEN_SOURCE_STATUS](OPEN_SOURCE_STATUS.md).

This publication does not establish scoring validity, production security,
physical-device audio acceptance, clinical accuracy or teaching effectiveness.

## v0.2.1-alpha.1 follow-up

The public repository now includes the three UI corrections described in
[UI_FIX_VERIFICATION](UI_FIX_VERIFICATION.md): schema-aligned research forms,
private next-training selection persistence, and native Android Back navigation.
App version is 0.2.1/code3. Model prompts, rubric and engine versions are unchanged.
Original private source history and old releases remain preserved. New application,
test and build changes were synchronized by an explicit file list; publication
license metadata and private-material exclusions remain in effect.

## v0.3.2-alpha.1 follow-up

Published on 2026-10-24 from private development revision
`a86f8d6323e40a26f008b79eca9e58ac0555d62e` (App 0.3.2 / code 6).
Thirty-nine application, core, test and build-helper files were copied through
an explicit allowlist. Existing implementation files outside that delta remain
identical to the current private source. Workspace version metadata was updated
while retaining the public MIT metadata; dependency versions, resolved URLs and
integrity values did not change. Original private history was not pushed.

This update publishes the already-built debug APK with SHA256
`5947374add2733ec4d17b158f059df8622528d92dd78f933556c5998ad09e756`.
Its source and local QA receipt refer to the revision above. The publication
round does not rerun npm/Gradle or call provider APIs. The 181 offline tests,
16 package checks and 48 emulator checks are the recorded 2026-10-23 results,
not new publication-day experiments. See [VERSION_0_3_2](VERSION_0_3_2.md).

Three new screenshots show that version on the dedicated emulator: the training
queue, record workflow and teacher-review history. They were visually checked
before publication and contain fictional `SIMULATED_ONLY` labels. Raw research
exports, model responses, audio, machine paths and signing keys remain excluded.
The earlier screenshots, source history and releases remain available.
