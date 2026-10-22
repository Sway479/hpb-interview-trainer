#!/usr/bin/env python3
"""Portable Android build/package checks using only the Python standard library."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import zipfile


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sdk_property(path: str, sdk_root: str) -> None:
    # Java properties treat backslashes, whitespace and ':' as escapes/separators.
    resolved = Path(sdk_root).resolve().as_posix()
    escaped = resolved.replace("\\", "\\\\").replace(":", "\\:").replace(" ", "\\ ")
    Path(path).write_text("sdk.dir=" + escaped + "\n", encoding="utf-8")


def verify_assets(args: argparse.Namespace) -> None:
    project = Path(args.project).resolve()
    apk = Path(args.apk).resolve()
    output = Path(args.output).resolve()
    web_root = project / "apps/mobile/dist"
    web_files = sorted(path for path in web_root.rglob("*") if path.is_file())
    notices = sorted((project / "licenses").glob("*.LICENSE")) + sorted(
        (project / "apps/mobile/android/upstream-licenses").glob("*.LICENSE"))
    if not web_files or not notices:
        raise ValueError("Current web bundle or upstream notices are missing.")
    web_assets, notice_assets = [], []
    with zipfile.ZipFile(apk) as archive:
        for path in web_files:
            relative = path.relative_to(web_root).as_posix()
            original = path.read_bytes()
            packaged = archive.read("assets/public/" + relative)
            if original != packaged:
                raise ValueError("APK web asset differs from current bundle: " + relative)
            web_assets.append({"path": relative, "sha256": sha(packaged), "bytes": len(packaged)})
        for path in notices:
            relative = "third-party-notices/" + path.name
            packaged = archive.read("assets/" + relative)
            if packaged != path.read_bytes():
                raise ValueError("APK upstream notice differs: " + relative)
            notice_assets.append({"path": relative, "sha256": sha(packaged)})
    build_gradle = (project / "apps/mobile/android/app/build.gradle").read_text(encoding="utf-8")
    version = re.search(r'versionName\s+"([^"]+)"', build_gradle)
    code = re.search(r"versionCode\s+(\d+)", build_gradle)
    if not version or not code:
        raise ValueError("Could not determine source versionName/versionCode.")
    output.parent.mkdir(parents=True, exist_ok=True)
    if apk != output:
        shutil.copyfile(apk, output)
    manifest = output.with_suffix(".web-assets.sha256")
    manifest_text = "".join(f'{entry["sha256"]}  {entry["path"]}\n' for entry in web_assets)
    manifest.write_bytes(manifest_text.encode("utf-8"))
    receipt_path = output.with_name(
        "standalone-preliminary-build-receipt.json" if args.stage == "preliminary" else "standalone-build-receipt.json")
    receipt = {
        "builtAtUtc": now(), "apk": str(output), "bytes": output.stat().st_size,
        "sha256": sha(output.read_bytes()), "packageId": "edu.hpb.interview", "variant": "debug",
        "stage": args.stage, "versionName": version.group(1), "versionCode": int(code.group(1)),
        "sdkRoot": args.sdk_root, "compileSdk": 36, "buildTools": "36.0.0",
        "javaHome": args.java_home, "gradleUserHome": args.gradle_user_home,
        "buildHostPlatform": sys.platform, "deviceVoiceVerified": False,
        "packagedWebAssetsVerified": True, "webAssetManifest": str(manifest),
        "webAssetManifestSha256": sha(manifest.read_bytes()), "webAssets": web_assets,
        "packagedUpstreamNoticesVerified": True, "upstreamNotices": notice_assets,
    }
    write_json(receipt_path, receipt)
    print(json.dumps({"apk": str(output), "sha256": receipt["sha256"], "receipt": str(receipt_path)}, ensure_ascii=False))


def command_output(command: list[str]) -> str:
    result = subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return result.stdout


def inspect(args: argparse.Namespace) -> None:
    apk = Path(args.apk).resolve()
    build_tools = Path(args.sdk_root).resolve() / "build-tools/36.0.0"
    aapt = str(build_tools / "aapt2")
    signer = str(build_tools / "apksigner")
    signature = command_output([signer, "verify", "--verbose", "--print-certs", str(apk)])
    badging = command_output([aapt, "dump", "badging", str(apk)])
    manifest = command_output([aapt, "dump", "xmltree", "--file", "AndroidManifest.xml", str(apk)])
    network = command_output([aapt, "dump", "xmltree", "--file", "res/xml/network_security_config.xml", str(apk)])
    provider = command_output([aapt, "dump", "xmltree", "--file", "res/xml/file_paths.xml", str(apk)])
    with zipfile.ZipFile(apk) as archive:
        config = json.loads(archive.read("assets/capacitor.config.json"))
        notices = sorted(name for name in archive.namelist()
                         if name.startswith("assets/third-party-notices/") and name.endswith(".LICENSE"))
    checks = {
        "packageAndVersion": "name='edu.hpb.interview' versionCode='2' versionName='0.2.0'" in badging,
        "minSdk24": "minSdkVersion:'24'" in badging,
        "targetSdk36": "targetSdkVersion:'36'" in badging,
        "internetPermission": "uses-permission: name='android.permission.INTERNET'" in badging,
        "microphonePermission": "uses-permission: name='android.permission.RECORD_AUDIO'" in badging,
        "audioSettingsPermission": "uses-permission: name='android.permission.MODIFY_AUDIO_SETTINGS'" in badging,
        "automaticBackupDisabled": bool(re.search(r"allowBackup[^\r\n]*=false", manifest) and
                                        re.search(r"fullBackupContent[^\r\n]*=false", manifest)),
        "dataExtractionRulesPresent": "dataExtractionRules" in manifest,
        "networkBaseDeniesCleartext": bool(re.search(r"E: base-config[^\r\n]*\r?\n\s+A: cleartextTrafficPermitted=false", network)),
        "debugLoopbackWhitelist": all("T: '" + host + "'" in network for host in ("localhost", "127.0.0.1", "::1"))
                                  and len(re.findall(r"E: domain \(", network)) == 3,
        "providerOnlyExportCache": 'name="hpb_exports"' in provider and 'path="hpb-exports/"' in provider
                                   and len(re.findall(r"E: (?:cache|external|files|root|external-files|external-cache)-path", provider)) == 1,
        "nativeLogsDisabled": config.get("loggingBehavior") == "none",
        "webViewHttpsOrigin": config.get("server", {}).get("androidScheme") == "https",
        "mixedContentDisabled": config.get("android", {}).get("allowMixedContent") is False,
        "nineUpstreamNotices": len(notices) == 9,
        "signatureV2": "Verified using v2 scheme (APK Signature Scheme v2): true" in signature,
    }
    failed = [name for name, passed in checks.items() if not passed]
    certificate = re.search(r"certificate SHA-256 digest: ([0-9a-f]{64})", signature)
    receipt_path = apk.with_suffix(".inspection.json")
    receipt = {
        "checkedAtUtc": now(), "apk": str(apk), "sha256": sha(apk.read_bytes()),
        "signatureCertificateSha256": certificate.group(1) if certificate else None,
        "checks": checks, "allChecksPassed": not failed, "runtimeVerified": False,
        "notices": notices, "networkPolicy": network.strip(), "fileProviderPolicy": provider.strip(),
    }
    write_json(receipt_path, receipt)
    if failed:
        raise ValueError("APK inspection failed: " + ", ".join(failed))
    print(json.dumps({"receipt": str(receipt_path), "sha256": receipt["sha256"], "checksPassed": len(checks)}))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    sdk = commands.add_parser("sdk-property")
    sdk.add_argument("path"); sdk.add_argument("sdk_root")
    verify = commands.add_parser("verify-assets")
    for name in ("project", "apk", "output", "sdk-root", "java-home", "gradle-user-home"):
        verify.add_argument("--" + name, required=True)
    verify.add_argument("--stage", choices=("candidate", "preliminary"), required=True)
    inspection = commands.add_parser("inspect")
    inspection.add_argument("--apk", required=True); inspection.add_argument("--sdk-root", required=True)
    args = parser.parse_args()
    if args.command == "sdk-property": sdk_property(args.path, args.sdk_root)
    elif args.command == "verify-assets": verify_assets(args)
    else: inspect(args)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError, zipfile.BadZipFile) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
