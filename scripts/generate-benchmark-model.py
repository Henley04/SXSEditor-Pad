#!/usr/bin/env python3
"""Regenerate the onboarding hardware-check ONNX benchmark model.

The old model was a chain of dense MatMuls. That measures raw GEMM throughput
but does NOT reflect how SoulX-Singer actually runs on device. The real SVS
pipeline is dominated by ConvNeXtV2-style convolutional blocks (the `preflow`
module and the Vocos vocoder backbone), operating on mel-spectrogram frames of
shape [1, C, T] = [1, 128, 250] (5 s of audio at 50 Hz).

This emits a compute-bound stack of `blocks` ConvNeXtV2 blocks that mirrors that
operator mix — pointwise conv (expand), depthwise conv, GELU, pointwise conv
(reduce), per-channel LayerNorm and a residual add. Because the same ops show up
in the real model, per-EP throughput here is a faithful proxy for real
SoulX-Singer inference speed, and clearly differentiates CPU / GPU / NPU(DSP).

FLOPs per block (C in, 4C hidden, depthwise kernel k over T frames):
  pointwise expand : 2 * T * C * 4C
  depthwise conv   : 2 * T * 4C * k
  pointwise reduce : 2 * T * 4C * C
So total ≈ blocks * 2 * T * (2*C*4C + 4C*k).

Output: writes src/assets/benchmark_model.js (base64 + metadata).
"""

import base64
import os
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

# ConvNeXtV2 benchmark dimensions (mirror the real SVS model).
C = 128          # mel channels (MEL_BINS)
T = 250          # frames = 5 s of audio at 50 Hz
EXPAND = 4       # ConvNeXtV2 hidden expansion factor (4C)
KERNEL = 7       # depthwise conv kernel size
BLOCKS = 24      # stacked ConvNeXtV2 blocks

OPSET = 20       # matches the app's ONNX opset 20 export
OUT_JS = os.path.join(os.path.dirname(__file__), "..", "src", "assets", "benchmark_model.js")

HIDDEN = C * EXPAND


def conv_flops(t, c_in, c_out, k):
    return 2 * t * c_in * c_out * k


FLOPS_PER_INFER = BLOCKS * (
    conv_flops(T, C, HIDDEN, 1)      # pointwise expand
    + conv_flops(T, HIDDEN, 1, KERNEL)  # depthwise conv (groups = HIDDEN)
    + conv_flops(T, HIDDEN, C, 1)    # pointwise reduce
)


def build_model():
    rng = np.random.default_rng(0)
    nodes = []
    initializers = []

    # One set of weights shared by every block. A benchmark measures compute
    # throughput, not weight count, so reusing the same tensor across all 24
    # blocks keeps the exact same FLOPs while keeping the model tiny (~0.5 MB).
    w = {}
    # LayerNorm over channel dims (axis=1 on [1, C, T] normalizes dims 1..2,
    # so optional scale/bias match the normalized shape (C, T)).
    w["ln/scale"] = numpy_helper.from_array(np.ones((C, T), dtype=np.float32), name="w/ln/scale")
    w["ln/bias"] = numpy_helper.from_array(np.zeros((C, T), dtype=np.float32), name="w/ln/bias")
    w["w1"] = numpy_helper.from_array((rng.standard_normal((HIDDEN, C, 1)) * 0.1).astype(np.float32), name="w/w1")
    w["b1"] = numpy_helper.from_array(np.zeros((HIDDEN,), dtype=np.float32), name="w/b1")
    w["w2"] = numpy_helper.from_array((rng.standard_normal((HIDDEN, 1, KERNEL)) * 0.1).astype(np.float32), name="w/w2")
    w["b2"] = numpy_helper.from_array(np.zeros((HIDDEN,), dtype=np.float32), name="w/b2")
    w["w3"] = numpy_helper.from_array((rng.standard_normal((C, HIDDEN, 1)) * 0.1).astype(np.float32), name="w/w3")
    w["b3"] = numpy_helper.from_array(np.zeros((C,), dtype=np.float32), name="w/b3")
    initializers = list(w.values())

    prev = "input"
    for i in range(BLOCKS):
        p = f"b{i}"

        # Per-channel LayerNorm (axis=1, over the C channels).
        nodes.append(helper.make_node(
            "LayerNormalization", [prev, "w/ln/scale", "w/ln/bias"],
            [f"{p}/ln"], name=f"{p}/ln", axis=1))

        # Pointwise expand C -> 4C (1D conv, kernel 1).
        nodes.append(helper.make_node("Conv", [f"{p}/ln", "w/w1", "w/b1"],
                                      [f"{p}/c1"], name=f"{p}/conv1"))

        nodes.append(helper.make_node("Gelu", [f"{p}/c1"], [f"{p}/g1"], name=f"{p}/gelu1"))

        # Depthwise conv 4C (groups = 4C), kernel 7 (1D conv, pad time).
        nodes.append(helper.make_node("Conv", [f"{p}/g1", "w/w2", "w/b2"],
                                      [f"{p}/c2"], name=f"{p}/dwconv",
                                      group=HIDDEN, pads=[KERNEL // 2, KERNEL // 2]))

        nodes.append(helper.make_node("Gelu", [f"{p}/c2"], [f"{p}/g2"], name=f"{p}/gelu2"))

        # Pointwise reduce 4C -> C (1D conv, kernel 1).
        nodes.append(helper.make_node("Conv", [f"{p}/g2", "w/w3", "w/b3"],
                                      [f"{p}/c3"], name=f"{p}/conv3"))

        # Residual add.
        nodes.append(helper.make_node("Add", [prev, f"{p}/c3"], [f"{p}/out"], name=f"{p}/add"))
        prev = f"{p}/out"

    graph = helper.make_graph(
        nodes,
        "benchmark_graph",
        inputs=[helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, C, T])],
        outputs=[helper.make_tensor_value_info(prev, TensorProto.FLOAT, [1, C, T])],
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
        "// Auto-generated compute-bound ONNX benchmark model.\n"
        f"// ConvNeXtV2-style stack: {BLOCKS} blocks, C={C}, T={T}, "
        f"expand={EXPAND}, kernel={KERNEL}.\n"
        f"// = {FLOPS_PER_INFER} FLOPs/inference — mirrors the real "
        "SoulX-Singer preflow/vocoder conv backbone.\n"
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