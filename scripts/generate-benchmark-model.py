#!/usr/bin/env python3
"""Regenerate the onboarding hardware-check ONNX benchmark model.

The old model was a single [1,64,64]x[64,64] MatMul (~0.5 MFLOPs/inference).
That is far too small: per-call overhead dominates, so every execution
provider reports almost the same throughput and the absolute number is
unrealistically low (e.g. ~400 MOPS on a Snapdragon 8 Elite).

This emits a compute-bound model: a chain of `chain_len` MatMuls, each
[1, M, M] x [M, M], reusing one [M, M] weight initializer. FLOPs per
inference = chain_len * 2 * M^3, which lands in the GFLOPs range so the
benchmark is dominated by real compute and clearly differentiates
CPU / GPU / NPU(DSP).

Output: writes src/assets/benchmark_model.js (base64 + metadata).
"""

import base64
import os
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

# Compute-bound MatMul chain dimensions.
M = 512          # matrix size (weight [M, M])
CHAIN_LEN = 8    # number of chained MatMuls

OPSET = 13
OUT_JS = os.path.join(os.path.dirname(__file__), "..", "src", "assets", "benchmark_model.js")

FLOPS_PER_INFER = CHAIN_LEN * 2 * M * M * M


def build_model():
    rng = np.random.default_rng(0)
    weight = rng.standard_normal((M, M)).astype(np.float32)

    nodes = []
    prev = "input"
    for i in range(CHAIN_LEN):
        out = f"h{i + 1}"
        nodes.append(
            helper.make_node("MatMul", [prev, "weight"], [out], name=f"matmul_{i}")
        )
        prev = out

    graph = helper.make_graph(
        nodes,
        "benchmark_graph",
        inputs=[helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, M, M])],
        outputs=[helper.make_tensor_value_info(prev, TensorProto.FLOAT, [1, M, M])],
        initializer=[numpy_helper.from_array(weight, name="weight")],
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
        "// Auto-generated compute-bound ONNX benchmark model.\n"
        f"// MatMul chain: {CHAIN_LEN} x [1,{M},{M}] x [{M},{M}] "
        f"= {FLOPS_PER_INFER} FLOPs/inference.\n"
        "// Used by the onboarding hardware check to benchmark CPU/NPU/GPU inference speed.\n"
        f"export const BENCHMARK_MODEL_BASE64 = \"{b64}\";\n"
        f"export const BENCHMARK_MODEL_SIZE = {len(raw)};\n"
    )
    with open(OUT_JS, "w", encoding="utf-8") as f:
        f.write(js)

    print(f"wrote {OUT_JS}")
    print(f"  model bytes : {len(raw)}")
    print(f"  base64 chars: {len(b64)}")
    print(f"  FLOPs/infer : {FLOPS_PER_INFER}  ({FLOPS_PER_INFER / 1e9:.2f} GFLOPs)")


if __name__ == "__main__":
    sys.exit(main())