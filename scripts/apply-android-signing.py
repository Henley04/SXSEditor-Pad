#!/usr/bin/env python3
"""
Idempotently inject a release signingConfig into the Tauri-generated
Android `app/build.gradle.kts` so release APKs are signed with the
upload key (otherwise Gradle emits an unsigned APK that fails to install
with "package info is null").

Run after `tauri android init`. Re-running is a no-op: it detects the
`signingConfigs { ... }` block and the `signingConfig = ...` line and
leaves the file untouched if they are already present.

Usage:
    python3 scripts/apply-android-signing.py [path/to/app/build.gradle.kts]

Defaults to src-tauri/gen/android/app/build.gradle.kts relative to the
repository root (script location).

The keystore + credentials are NOT referenced here — they live in
`gen/android/keystore.properties` (written by the CI step). This script
only wires Gradle to read that file.
"""
from __future__ import annotations

import os
import re
import sys

# Path resolution: default to the Tauri-generated app module next to the
# repo root, regardless of the caller's CWD.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PATH = os.path.join(
    SCRIPT_DIR, os.pardir, "src-tauri", "gen", "android", "app", "build.gradle.kts"
)

# Properties file written by the CI step:
#   keyAlias=...
#   keyPassword=...
#   storePassword=...
#   storeFile=<absolute path to decoded .jks>
#
# Uses SHORT class names (Properties / FileInputStream) — fully-qualified
# `java.util.Properties` / `java.io.FileInputStream` FAIL to compile inside
# the AGP `signingConfigs { create("release") { ... } }` Kotlin-DSL scope
# because the bare identifier `java` resolves to an in-scope AGP extension
# property rather than the `java` package, yielding
# "Unresolved reference: util" / "Unresolved reference: io". The imports are
# added at file top (see `REQUIRED_IMPORTS`) so the short names resolve.
SIGNING_CONFIG_BLOCK = """    signingConfigs {
        create("release") {
            val keystorePropertiesFile = rootProject.file("keystore.properties")
            val keystoreProperties = Properties()
            if (keystorePropertiesFile.exists()) {
                keystoreProperties.load(FileInputStream(keystorePropertiesFile))
            }
            keyAlias = keystoreProperties.getProperty("keyAlias")
            keyPassword = keystoreProperties.getProperty("keyPassword")
            storeFile = file(keystoreProperties.getProperty("storeFile"))
            storePassword = keystoreProperties.getProperty("storePassword")
        }
    }
"""

# Imports the signingConfigs block needs. Inserted at the top of the file
# (after the existing import block) so the short class names resolve.
# `java.util.Properties` + `java.io.FileInputStream` — see note above on
# why we MUST import instead of using fully-qualified names.
REQUIRED_IMPORTS = ["java.util.Properties", "java.io.FileInputStream"]

# Line injected into the existing `release` buildType so it picks up the
# release signing config. Anchored on the buildType's opening line so it
# survives reformats of the surrounding buildTypes block.
RELEASE_SIGNING_LINE = "        signingConfig = signingConfigs.getByName(\"release\")"


def patch(path: str) -> None:
    if not os.path.isfile(path):
        raise FileNotFoundError(f"build.gradle.kts not found: {path}")

    with open(path, "r", encoding="utf-8") as f:
        src = f.read()
    original = src

    # 1. Ensure the imports the signingConfigs block needs are present
    #    (Tauri's template does not ship them). Insert after the existing
    #    `import ...` block to keep a clean grouping; skip any already
    #    present (idempotent). We CANNOT use fully-qualified
    #    `java.util.Properties` / `java.io.FileInputStream` inline because
    #    inside the AGP signingConfigs Kotlin-DSL scope the bare `java`
    #    resolves to an in-scope AGP extension property, not the package
    #    ("Unresolved reference: util"/"io"). So the imports MUST exist.
    for fqcn in REQUIRED_IMPORTS:
        import_line = f"import {fqcn}\n"
        if import_line.strip() in src:
            continue
        # Append after the last top-level import line.
        new_src = re.sub(
            r"((?:^import [^\n]+\n)+)",
            lambda m: m.group(1) + import_line,
            src,
            count=1,
            flags=re.MULTILINE,
        )
        if new_src != src:
            src = new_src
        else:
            # Fallback: no existing import block at all — prepend.
            src = import_line + src

    # 2. Inject the signingConfigs { ... } block immediately before the
    #    `buildTypes {` block, but inside `android { ... }`. The
    #    signingConfigs block must sit at android-block scope (not
    #    buildTypes scope) per Gradle's Android DSL.
    if "signingConfigs {" not in src:
        # Match the buildTypes opening (4-space indent inside android{}),
        # insert our block ahead of it. Keep indentation consistent.
        pattern = re.compile(r"^(\s*)buildTypes\s*\{", re.MULTILINE)
        match = pattern.search(src)
        if not match:
            raise RuntimeError(
                "Could not locate `buildTypes {` block to anchor signingConfigs"
            )
        insert_at = match.start()
        src = src[:insert_at] + SIGNING_CONFIG_BLOCK + "\n" + src[insert_at:]

    # 3. Wire the release buildType to use the release signing config.
    #    Find `getByName("release") {` (Tauri's template form) and inject
    #    `signingConfig = ...` as the first statement of that block, if
    #    not already present. Idempotent.
    if "signingConfig = signingConfigs.getByName(\"release\")" not in src:
        # Match the release buildType opener; tolerate varying indentation
        # and trailing content on the same line.
        rel_pattern = re.compile(
            r'(getByName\(\s*"release"\s*\)\s*)\{([^\n]*\n)',
            re.MULTILINE,
        )
        new_src, n = rel_pattern.subn(
            lambda m: m.group(1) + "{" + m.group(2) + RELEASE_SIGNING_LINE + "\n",
            src,
            count=1,
        )
        if n == 0:
            raise RuntimeError(
                "Could not locate `getByName(\"release\") {` to inject signingConfig"
            )
        src = new_src

    if src == original:
        print(f"[signing] {path}: already patched, no change")
    else:
        with open(path, "w", encoding="utf-8") as f:
            f.write(src)
        print(f"[signing] {path}: injected release signingConfig")


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PATH
    path = os.path.abspath(path)
    patch(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
