#!/usr/bin/env bash
# Checks package identity and packaged security policies; no runtime/API request.
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-${HOME}/Library/Android/sdk}}"
java_home="${JAVA_HOME:-}"
python_bin="${HPB_PYTHON:-python3}"
if [ "$#" -eq 0 ] || [ "$1" = --help ]; then
  printf 'Usage: bash tools/inspect-android.sh APK [--sdk-root PATH] [--java-home PATH]\n'
  exit 0
fi
apk="$1"; shift
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || { printf 'Missing option value.\n' >&2; exit 2; }
  case "$1" in --sdk-root) sdk_root="$2" ;; --java-home) java_home="$2" ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;; esac
  shift 2
done
if [ -z "$java_home" ] && [ -x /usr/libexec/java_home ]; then java_home="$(/usr/libexec/java_home -v 21 2>/dev/null || true)"; fi
[ -x "$java_home/bin/java" ] || { printf 'Set JAVA_HOME to JDK 21.\n' >&2; exit 1; }
export JAVA_HOME="$java_home" PATH="$java_home/bin:$PATH"
"$python_bin" "$project_root/tools/android_artifact.py" inspect --apk "$apk" --sdk-root "$sdk_root"
