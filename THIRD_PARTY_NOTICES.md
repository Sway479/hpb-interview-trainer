# Third-party software

The MIT license at the repository root covers project-original work. Dependencies,
templates and their notices retain their own licenses; they are not relicensed.

| Component | Fixed version/source | License | Retained text |
| --- | --- | --- | --- |
| Ionic React Vite starter | ionic-team/starters, `15aee8b93f46b48e4db7464bceb4b0560ea5dc35` | MIT | `licenses/ionic-starters.LICENSE` |
| Ionic Framework / React integration | 9.0.8, Ionic Team / Drifty Co. | MIT | `licenses/ionic-framework.LICENSE` |
| Capacitor | 8.5.3, Ionic Team | MIT | `licenses/capacitor.LICENSE` |
| wavtools | 0.1.5, Keith Horwood and OpenAI | MIT | `licenses/wavtools.LICENSE` |
| React / React DOM | 19.0.0, Meta Platforms and affiliates | MIT | `licenses/react.LICENSE` |
| Ionicons | 8.1.0, Ionic Team | MIT | `licenses/ionicons.LICENSE` |
| OkHttp | 5.4.0, Square / [square/okhttp](https://github.com/square/okhttp) | Apache-2.0 | `apps/mobile/android/upstream-licenses/okhttp.LICENSE` |
| Okio | 3.17.0, Square / [square/okio](https://github.com/square/okio) | Apache-2.0 | `apps/mobile/android/upstream-licenses/okio.LICENSE` |
| Kotlin standard library | 2.2.21, JetBrains / [JetBrains/kotlin](https://github.com/JetBrains/kotlin) | Apache-2.0 | `apps/mobile/android/upstream-licenses/kotlin.LICENSE` |
| Gradle wrapper | 8.14.3, [Gradle](https://github.com/gradle/gradle) | Apache-2.0 | wrapper script headers and JAR `META-INF/LICENSE` |

The nine application notices also remain under
`apps/mobile/android/app/src/main/assets/third-party-notices/` and are checked by
the existing packaging scripts. Do not remove the two wavtools copyright lines.
The provenance and fixed source revisions are described in [UPSTREAM](docs/UPSTREAM.md).

The complete npm dependency versions, download integrity values, and license
metadata are in `package-lock.json`; a readable inventory is retained at
`licenses/npm-dependency-inventory.json`. It includes MIT, Apache-2.0, BSD, ISC,
BlueOak-1.0.0, Unlicense, 0BSD, and MPL-2.0 entries. In particular, lightningcss
and its platform packages are MPL-2.0 development tools. This source repository
does not redistribute node_modules or those tool binaries. Installed packages'
own notices and license terms remain authoritative; the inventory is not a
blanket license or a complete dependency compliance certification.

Linked assessment publications and API documentation remain external source
references. Their full texts, forms and institutional templates are not bundled
or licensed under the project's MIT license. The rubric is a project adaptation,
not a claim of official assessment endorsement or validated educational effect.
