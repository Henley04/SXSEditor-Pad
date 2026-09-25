#!/usr/bin/env python3
"""Regenerate the onboarding hardware-check ONNX benchmark model.

History: this model used to be a ConvNeXtV2-style conv stack (72 small-channel
Convs + LayerNorm + GELU per 24 blocks, 1.62 GFLOPs). Real-device results on
flagship SoCs (e.g. Snapdragon 8 Elite) showed only ~45 GOPS for BOTH the CPU
and the accelerator rows: the workload is memory-bound (layer tensors are only
128x250 = 128 KB, so NNAPI/NPU spends most of its time on per-layer dispatch
and data movement instead of computing), and the same bottleneck dominates
every backend, so all rows converge to the same meaningless number.

This version emits a compute-bound GEMM chain instead — the industry-standard
way to measure peak hardware throughput:

    Y1 = MatMul(X, W1)
    Y2 = MatMul(Y1, W2) + b
    ... LAYERS chained MatMuls, alternating two shared weight sets.

Every layer does dense M=N=K=S GEMMs with large tiles, so the accelerator
(saturating FP16 on NPU/GPU) and the CPU (MLAS multi-threaded FP32) both run
close to their real peak throughput, and the two backends differentiate
clearly instead of converging.

FLOPs per inference = LAYERS * 2 * S^3 (each MatMul of [S,S]x[S,S]).

Output: writes src/assets/benchmark_model.js (base64 + metadata) and keeps
src/assets/benchmark_model.onnx in sync for inspection.
"""

import base64
import os
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

# GEMM benchmark dimensions.
S = 768           # M = N = K per MatMul (tile-friendly, divisible by 32)
LAYERS = 4        # chained MatMuls; weights alternate W1/W2 (shared per parity)

OPSET = 20        # matches the app's ONNX opset 20 export
OUT_JS = os.path.join(os.path.dirname(__file__), "..", "src", "assets", "benchmark_model.js")
OUT_ONNX = os.path.join(os.path.dirname(__file__), "..", "src", "assets", "benchmark_model.onnx")

FLOPS_PER_INFER = LAYERS * 2 * S * S * S


def build_model():
    rng = np.random.default_rng(0)
    nodes = []
    initializers = []

    # Two weight sets, reused by parity so the model file stays ~4.7 MB while
    # every layer still performs a fresh dense GEMM. Alternating weights also
    # prevents any hypothetical "same-weight folding" from collapsing the chain.
    w1 = (rng.standard_normal((S, S)) * 0.02).astype(np.float32)
    w2 = (rng.standard_normal((S, S)) * 0.02).astype(np.float32)
    bias = np.zeros((S,), dtype=np.float32)
    initializers.append(numpy_helper.from_array(w1, name="w/w1"))
    initializers.append(numpy_helper.from_array(w2, name="w/w2"))
    initializers.append(numpy_helper.from_array(bias, name="w/bias"))

    prev = "input"
    for i in range(LAYERS):
        wname = "w/w1" if i % 2 == 0 else "w/w2"
        out = f"y{i+1}" if i < LAYERS - 1 else "output"
        mm = helper.make_node("MatMul", [prev, wname], [f"y{i+1}/mm"], name=f"matmul{i+1}")
        # A per-layer vector add keeps each GEMM's output a distinct graph node
        # (defensive: no backend can fold the chain) and is itself a supported
        # NNAPI op. The bias is all-zero, so it does not change magnitudes.
        add = helper.make_node("Add", [f"y{i+1}/mm", "w/bias"], [out], name=f"add{i+1}")
        nodes.extend([mm, add])
        prev = out

    graph = helper.make_graph(
        nodes,
        "benchmark_graph",
        inputs=[helper.make_tensor_value_info("input", TensorProto.FLOAT, [S, S])],
        outputs=[helper.make_tensor_value_info("output", TensorProto.FLOAT, [S, S])],
        initializer=initializers,
    )
    model = helper.make_model(
        graph,
        producer_name="sxseditor-benchmark",
        opset_imports=[helper.make_opsetid("", OPSET)],
    )
    onnx.checker.check_model(model)
    return model


def main():
    model = build_model()
    raw = model.SerializeToString()
    b64 = base64.b64encode(raw).decode("ascii")

    js = (
        "// Auto-generated compute-bound ONNX benchmark model (do not edit by hand;\n"
        "// run scripts/generate-benchmark-model.py to regenerate).\n"
        f"// GEMM chain: {LAYERS} x MatMul [{S},{S}]x[{S},{S}] = {FLOPS_PER_INFER} FLOPs/inference.\n"
        "// Compute-bound by design: saturates CPU (MLAS FP32) and accelerator\n"
        "// (NNAPI/CoreML FP16) so the reported GOPS/TOPS reflects real peak throughput.\n"
        "// Used by the onboarding hardware check to benchmark CPU/accelerator speed.\n"
        f"export const BENCHMARK_MODEL_BASE64 = \"{b64}\";\n"
        f"export const BENCHMARK_MODEL_SIZE = {len(raw)};\n"
    )
    with open(OUT_JS, "w", encoding="utf-8") as f:
        f.write(js)
    with open(OUT_ONNX, "wb") as f:
        f.write(raw)

    print(f"wrote {OUT_JS}")
    print(f"wrote {OUT_ONNX}")
    print(f"  model bytes : {len(raw)}")
    print(f"  base64 chars: {len(b64)}")
    print(f"  FLOPs/infer : {FLOPS_PER_INFER}  ({FLOPS_PER_INFER / 1e9:.2f} GFLOPs)")


if __name__ == "__main__":
    sys.exit(main())
