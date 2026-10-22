"""Scan configured credential bytes without printing them; no provider requests are made.

Defaults target standalone v0.2.0. Use --version 0.1.0 or explicit artifact paths
to check an older delivery. Keys come from named environment variables and a
local .env file, when present; neither key values nor key fingerprints are saved.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import zipfile


ROOT = Path(__file__).resolve().parents[1]
DEFAULTS = {
    "0.2.0": {
        "apk": "artifacts/android/hpb-voice-standalone-debug.apk",
        "source_zip": "artifacts/hpb-voice-standalone-source-v0.2.0.zip",
        "receipt": "artifacts/delivery-secret-scan-v0.2.0.json",
    },
    "0.1.0": {
        "apk": "artifacts/android/hpb-voice-prototype-debug.apk",
        "source_zip": "artifacts/hpb-voice-prototype-source-v0.1.0.zip",
        "receipt": "artifacts/delivery-secret-scan-v0.1.0.json",
    },
}
DEFAULT_KEY_ENV_NAMES = (
    "DASHSCOPE_API_KEY", "QIANWEN_API_KEY", "QWEN_API_KEY", "FLASH_API_KEY",
    "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "CUSTOM_API_KEY", "PROVIDER_API_KEY",
)


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--version", choices=tuple(DEFAULTS), default="0.2.0", help="Artifact default set (default: 0.2.0).")
    parser.add_argument("--apk", type=Path, help="APK path; relative paths use the project root.")
    parser.add_argument("--source-zip", type=Path, help="Source ZIP path; relative paths use the project root.")
    parser.add_argument("--receipt", type=Path, help="JSON receipt path; defaults include the version, preserving old receipts.")
    parser.add_argument("--research-zip", type=Path, action="append", default=[],
                        help="Optional Android research export ZIP to scan; repeat for multiple exports. No export is required by default.")
    parser.add_argument("--env-file", "--secret-file", dest="env_files", type=Path, action="append",
                        help="Private KEY=VALUE file; repeat to scan multiple configurations. Defaults to .env only when present.")
    parser.add_argument("--no-env-file", action="store_true", help="Do not read the default .env; explicitly supplied --env-file paths still apply.")
    parser.add_argument("--key-env", action="append", default=[], metavar="NAME",
                        help="Additional environment variable containing a provider key. Supply the variable name, never the key itself.")
    return parser.parse_args()


def resolve(path: Path | str) -> Path:
    path = Path(path)
    return (path if path.is_absolute() else ROOT / path).resolve()


def display(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def private_env_values(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        match = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$", line)
        if not match:
            continue
        name, value = match.groups()
        value = value.strip()
        if value.startswith(("'", '"', "`")):
            quote = value[0]
            # API keys are single-line values. Ignore an optional comment after the closing quote.
            end = None
            escaped = False
            for index, character in enumerate(value[1:], start=1):
                if character == quote and not escaped:
                    end = index
                    break
                escaped = not escaped if character == "\\" else False
            if end is None:
                raise ValueError("Unclosed credential configuration value")
            value = value[1:end]
            if quote == '"':
                value = value.replace("\\n", "\n").replace("\\r", "\r")
        else:
            value = value.split("#", 1)[0].strip()
        values[name] = value
    return values


def configured_secrets(args: argparse.Namespace, issues: list[str]) -> tuple[list[bytes], list[Path]]:
    names = set(DEFAULT_KEY_ENV_NAMES) | set(args.key_env)
    files = [resolve(path) for path in (args.env_files or [])]
    if not args.no_env_file and args.env_files is None and (ROOT / ".env").is_file():
        files.append(ROOT / ".env")
    configured: set[str] = set()
    for path in files:
        if not path.is_file():
            issues.append("Missing private credential configuration: " + display(path))
            continue
        try:
            values = private_env_values(path)
        except (OSError, UnicodeError, ValueError):
            issues.append("Unable to read private credential configuration: " + display(path))
            continue
        names.update(name for name in values if name == "API_KEY" or name.endswith("_API_KEY"))
        configured.update(value for name, value in values.items() if name in names and value)
    configured.update(value for name in names if (value := os.environ.get(name)))
    if not configured:
        issues.append("No configured provider credential was available for an exact-value scan; set a supported key environment variable or supply --env-file.")
    return sorted({value.encode("utf-8") for value in configured}, key=len, reverse=True), files


def contains_secret(stream, secrets: list[bytes]) -> bool:
    if not secrets:
        return False
    overlap = max(map(len, secrets)) - 1
    tail = b""
    while chunk := stream.read(1024 * 1024):
        data = tail + chunk
        if any(value in data for value in secrets):
            return True
        tail = data[-overlap:] if overlap else b""
    return False


def forbidden_env_entry(name: str) -> bool:
    leaf = PurePosixPath(name.replace("\\", "/")).name.lower()
    return (leaf == ".env" or leaf.startswith(".env.")) and leaf != ".env.example"


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            result.update(chunk)
    return result.hexdigest()


def scan_archive(path: Path, secrets: list[bytes], matches: list[str], issues: list[str]) -> dict | None:
    label = display(path)
    if not path.is_file():
        issues.append("Missing delivery artifact: " + label)
        return None
    try:
        with zipfile.ZipFile(path) as archive:
            entries = [item for item in archive.infolist() if not item.is_dir()]
            for item in entries:
                entry_label = label + "::" + item.filename
                if forbidden_env_entry(item.filename):
                    matches.append(entry_label + " (unexpected environment file)")
                with archive.open(item) as stream:
                    if contains_secret(stream, secrets):
                        matches.append(entry_label)
        return {"entries": len(entries), "bytes": path.stat().st_size, "sha256": digest(path)}
    except (OSError, zipfile.BadZipFile, RuntimeError, NotImplementedError):
        issues.append("Unable to completely inspect ZIP/APK artifact: " + label)
        return None


def redact_report(value, secrets: list[bytes]):
    if isinstance(value, str):
        for secret in secrets:
            value = value.replace(secret.decode("utf-8"), "[redacted]")
        return value
    if isinstance(value, list):
        return [redact_report(item, secrets) for item in value]
    if isinstance(value, dict):
        return {redact_report(key, secrets): redact_report(item, secrets) for key, item in value.items()}
    return value


def main() -> int:
    args = arguments()
    defaults = DEFAULTS[args.version]
    apk, source_zip = resolve(args.apk or defaults["apk"]), resolve(args.source_zip or defaults["source_zip"])
    receipt_path = resolve(args.receipt or defaults["receipt"])
    research_zips = [resolve(path) for path in args.research_zip]
    issues: list[str] = []
    matches: list[str] = []
    secrets, env_files = configured_secrets(args, issues)
    if receipt_path in {apk, source_zip, *research_zips, *env_files} or receipt_path.suffix.lower() != ".json":
        print("Receipt must be a separate JSON output file; no input artifact or credential file was modified.", file=sys.stderr)
        return 2

    ignored = subprocess.run(["git", "check-ignore", "-q", ".env"], cwd=ROOT, capture_output=True).returncode == 0
    if not ignored:
        issues.append("The project .env path is not ignored by Git.")
    inventory = subprocess.run(["git", "-c", "core.quotepath=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
                               cwd=ROOT, capture_output=True)
    source_count = 0
    if inventory.returncode:
        issues.append("Unable to read the tracked and nonignored source inventory from Git.")
    else:
        for relative in sorted(set(inventory.stdout.decode("utf-8").split("\0"))):
            if not relative or relative.replace("\\", "/").startswith("artifacts/"):
                continue
            source = resolve(relative)
            if not source.is_relative_to(ROOT):
                issues.append("Source path resolves outside the project: " + relative)
                continue
            if not source.is_file():
                continue
            source_count += 1
            try:
                with source.open("rb") as stream:
                    if contains_secret(stream, secrets):
                        matches.append(relative)
            except OSError:
                issues.append("Unable to inspect candidate source file: " + relative)

    artifacts = {}
    for path in dict.fromkeys([apk, source_zip, *research_zips]):
        result = scan_archive(path, secrets, matches, issues)
        if result is not None:
            artifacts[display(path)] = result
    receipt = redact_report({
        "kind": "exact_configured_provider_credential_scan", "version": args.version,
        "envIgnoredByGit": ignored, "configuredCredentialCount": len(secrets), "candidateSourceFiles": source_count,
        "artifacts": artifacts, "researchExportsRequested": len(research_zips),
        "matches": sorted(set(matches)), "issues": issues,
        "status": "passed" if not issues and not matches else "failed",
        "scope": "Tracked plus nonignored source bytes and decompressed entries of the requested APK/ZIP files; no network calls or native KeyStore reads.",
    }, secrets)
    encoded = json.dumps(receipt, ensure_ascii=False, indent=2)
    try:
        receipt_path.parent.mkdir(parents=True, exist_ok=True)
        receipt_path.write_text(encoded, encoding="utf-8")
    except OSError:
        print("Unable to write the delivery scan receipt.", file=sys.stderr)
        return 2
    print(encoded)
    return 0 if receipt["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
