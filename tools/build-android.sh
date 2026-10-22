#!/usr/bin/env bash
# macOS / Unix build entry. No provider credential is read by this script.
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-${HOME}/Library/Android/sdk}}"
java_home="${JAVA_HOME:-}"
python_bin="${HPB_PYTHON:-python3}"
artifact_root="${HPB_ANDROID_ARTIFACT_DIR:-${project_root}/artifacts/android-macos}"
debug_keystore="${HPB_DEBUG_KEYSTORE:-}"
if [ -z "$debug_keystore" ] && [ -f "$project_root/.private-signing/debug.keystore" ]; then
  debug_keystore="$project_root/.private-signing/debug.keystore"
fi
skip_web=0
skip_sync=0
preliminary=0

usage() {
  cat <<'USAGE'
Usage: bash tools/build-android.sh [options]
  --sdk-root PATH        SDK with platform android-36 and build-tools 36.0.0
  --java-home PATH       JDK 21 home (otherwise JAVA_HOME or macOS java_home)
  --artifact-dir PATH    Output directory (default artifacts/android-macos)
  --debug-keystore PATH  Existing Android debug key to preserve update signing
  --skip-web-build       Use only after a separately verified current web build
  --skip-sync            Use only after a separately verified Capacitor sync
  --preliminary         Write separately named preliminary output
  --help
Environment: ANDROID_HOME, JAVA_HOME, GRADLE_USER_HOME, HPB_PYTHON,
             HPB_ANDROID_ARTIFACT_DIR, HPB_DEBUG_KEYSTORE.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --sdk-root|--java-home|--artifact-dir|--debug-keystore)
      [ "$#" -ge 2 ] || { printf 'Missing value for %s\n' "$1" >&2; exit 2; }
      case "$1" in
        --sdk-root) sdk_root="$2" ;;
        --java-home) java_home="$2" ;;
        --artifact-dir) artifact_root="$2" ;;
        --debug-keystore) debug_keystore="$2" ;;
      esac
      shift 2 ;;
    --skip-web-build) skip_web=1; shift ;;
    --skip-sync) skip_sync=1; shift ;;
    --preliminary) preliminary=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v node >/dev/null || { printf 'Node.js 22.12+ is required; Node.js 24 is recommended.\n' >&2; exit 1; }
command -v npm >/dev/null || { printf 'npm is required.\n' >&2; exit 1; }
command -v "$python_bin" >/dev/null || { printf 'Python 3 is required; set HPB_PYTHON to its executable.\n' >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<12)){console.error("Node.js 22.12+ required");process.exit(1)}'

if [ -z "$java_home" ] && [ -x /usr/libexec/java_home ]; then
  java_home="$(/usr/libexec/java_home -v 21 2>/dev/null || true)"
fi
if [ -z "$java_home" ] && [ -x '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java' ]; then
  java_home='/Applications/Android Studio.app/Contents/jbr/Contents/Home'
fi
if [ ! -x "${java_home}/bin/java" ]; then
  printf 'JDK 21 not found. Set JAVA_HOME to its Home directory or use --java-home.\n' >&2
  exit 1
fi
java_major="$("${java_home}/bin/java" -version 2>&1 | sed -n '1s/.*version "\([0-9]*\).*/\1/p')"
[ "$java_major" = 21 ] || { printf 'This verified toolchain requires JDK 21; selected major: %s\n' "$java_major" >&2; exit 1; }

sdk_root="$(cd "$sdk_root" && pwd -P)"
java_home="$(cd "$java_home" && pwd -P)"
for required in "$sdk_root/platforms/android-36/android.jar" "$sdk_root/build-tools/36.0.0/aapt2" "$sdk_root/build-tools/36.0.0/apksigner"; do
  [ -f "$required" ] || { printf 'Required SDK file missing: %s\n' "$required" >&2; exit 1; }
done
[ -d "$project_root/node_modules" ] || { printf 'Run npm ci in the project root before building.\n' >&2; exit 1; }

export JAVA_HOME="$java_home" ANDROID_HOME="$sdk_root" ANDROID_SDK_ROOT="$sdk_root"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-${project_root}/.cache/gradle-macos}"
export PATH="${JAVA_HOME}/bin:${PATH}"
mkdir -p "$GRADLE_USER_HOME" "$artifact_root"
artifact_root="$(cd "$artifact_root" && pwd -P)"
android_root="$project_root/apps/mobile/android"

# local.properties is ignored machine-local state. Never reuse the Windows SDK path.
"$python_bin" "$project_root/tools/android_artifact.py" sdk-property "$android_root/local.properties" "$sdk_root"

cd "$project_root"
if [ "$skip_web" -eq 0 ]; then npm run build --workspace @hpb/mobile; fi
if [ "$skip_sync" -eq 0 ]; then
  (cd apps/mobile && npx --no-install cap sync android)
fi

notice_root="$android_root/app/src/main/assets/third-party-notices"
mkdir -p "$notice_root"
notice_count=0
for source_dir in "$project_root/licenses" "$android_root/upstream-licenses"; do
  for notice in "$source_dir"/*.LICENSE; do
    [ -f "$notice" ] || continue
    cp "$notice" "$notice_root/$(basename "$notice")"
    notice_count=$((notice_count + 1))
  done
done
[ "$notice_count" -gt 0 ] || { printf 'Upstream license notices are missing.\n' >&2; exit 1; }

gradle_args=(--gradle-user-home "$GRADLE_USER_HOME" --no-daemon --console=plain)
if [ -n "$debug_keystore" ]; then
  [ -f "$debug_keystore" ] || { printf 'Debug keystore does not exist: %s\n' "$debug_keystore" >&2; exit 1; }
  export HPB_DEBUG_KEYSTORE="$(cd "$(dirname "$debug_keystore")" && pwd -P)/$(basename "$debug_keystore")"
  gradle_args+=("-PhpbDebugKeystore=$HPB_DEBUG_KEYSTORE")
else
  printf 'Signing: using this Mac user default debug key. Check certificate identity before updating an existing phone.\n'
fi

(cd "$android_root" && bash ./gradlew "${gradle_args[@]}" :app:assembleDebug)

artifact_base='hpb-voice-standalone-debug'
stage='candidate'
if [ "$preliminary" -eq 1 ]; then artifact_base='hpb-voice-standalone-preliminary-debug'; stage='preliminary'; fi
"$python_bin" "$project_root/tools/android_artifact.py" verify-assets \
  --project "$project_root" --apk "$android_root/app/build/outputs/apk/debug/app-debug.apk" \
  --output "$artifact_root/$artifact_base.apk" --stage "$stage" \
  --sdk-root "$sdk_root" --java-home "$java_home" --gradle-user-home "$GRADLE_USER_HOME"
bash "$project_root/tools/inspect-android.sh" "$artifact_root/$artifact_base.apk" --sdk-root "$sdk_root" --java-home "$java_home"
