#!/usr/bin/env bash
# Downloads the ONNX Runtime Android native library and bundles it into the
# Tauri-generated Android project's jniLibs, so the Rust `ort` crate (which
# uses `load-dynamic`) can `dlopen` libonnxruntime.so at runtime.
#
# The version must match the ONNX Runtime targeted by the pinned `ort` crate
# in src-tauri/Cargo.toml (ort 2.0.0-rc.13 -> ONNX Runtime 1.28). Patch-level
# releases within a minor are ABI-compatible with the ort-sys bindings.
#
# Usage:
#   bundle-ort-android.sh <abi> [<abi> ...]
#     <abi> is one of: arm64-v8a armeabi-v7a x86 x86_64
#
# Must run AFTER `tauri android init --ci` (which creates gen/android) and
# BEFORE `tauri android build`.
set -euo pipefail

ORT_VERSION="${ORT_VERSION:-1.28.0}"
AAR_URL="https://repo1.maven.org/maven2/com/microsoft/onnxruntime/onnxruntime-android/${ORT_VERSION}/onnxruntime-android-${ORT_VERSION}.aar"
JNI_BASE="src-tauri/gen/android/app/src/main/jniLibs"
AAR="${TMPDIR:-/tmp}/onnxruntime-android-${ORT_VERSION}.aar"

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <abi> [<abi> ...]" >&2
  exit 1
fi

if [ ! -f "$AAR" ]; then
  echo "Downloading ONNX Runtime Android ${ORT_VERSION} ..."
  curl -fsSL -o "$AAR" "$AAR_URL"
fi

for abi in "$@"; do
  dest="$JNI_BASE/$abi"
  mkdir -p "$dest"
  unzip -j -o "$AAR" "jni/$abi/libonnxruntime.so" -d "$dest/"
  if [ ! -s "$dest/libonnxruntime.so" ]; then
    echo "ERROR: failed to extract jni/$abi/libonnxruntime.so from AAR" >&2
    exit 1
  fi
  echo "bundled libonnxruntime.so ($abi): $(stat -c%s "$dest/libonnxruntime.so") bytes"
done