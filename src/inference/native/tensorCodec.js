/**
 * 二进制张量帧编解码器 — 与 Rust 侧 src-tauri/src/inference/frame.rs 对应。
 *
 * 帧布局（小端）：
 *   [u32 header_len][header JSON (UTF-8)][blob bytes]
 *
 * 请求头: { v:1, modelId, inputs:[{name,dtype,shape,offset,length}] }
 * 响应头: { v:1, outputs:[{name,dtype,shape,offset,length}] }
 *
 * 设计动机：Tauri invoke() 默认把参数 JSON 序列化——对 diffusion 每步
 * 数 MB 的张量来说开销巨大。原始帧只在 header 里放元数据，负载按字节
 * 拼接；桌面/iOS 走 application/octet-stream，Android 走 base64 JSON。
 */

export const FRAME_VERSION = 1;

/**
 * dtype 元数据：字节宽度 + 输出端 TypedArray 构造器。
 * float16 以 Uint16Array 承载位模式（与 onnxruntime-web 的约定一致）。
 */
export const DTYPE_META = {
    float32: { bytes: 4, Ctor: Float32Array },
    float16: { bytes: 2, Ctor: Uint16Array },
    float64: { bytes: 8, Ctor: Float64Array },
    int8: { bytes: 1, Ctor: Int8Array },
    uint8: { bytes: 1, Ctor: Uint8Array },
    int16: { bytes: 2, Ctor: Int16Array },
    uint16: { bytes: 2, Ctor: Uint16Array },
    int32: { bytes: 4, Ctor: Int32Array },
    uint32: { bytes: 4, Ctor: Uint32Array },
    int64: { bytes: 8, Ctor: BigInt64Array },
    uint64: { bytes: 8, Ctor: BigUint64Array },
    bool: { bytes: 1, Ctor: Uint8Array },
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * 从张量样对象中提取原始字节视图。
 * 接受 onnxruntime-web Tensor、NativeTensor 或任何 {data, dims, type} 形状。
 * @returns {{dtype: string, shape: number[], bytes: Uint8Array}}
 */
export function tensorToBytes(tensor) {
    const dtype = tensor.type || tensor.dtype || 'float32';
    const meta = DTYPE_META[dtype];
    if (!meta) throw new Error(`tensorCodec: unsupported dtype '${dtype}'`);
    const shape = Array.from(tensor.dims || tensor.shape || [1], (d) => Number(d));
    const data = tensor.data;
    if (data == null) throw new Error('tensorCodec: tensor has no data');

    // 直接基于底层 buffer 建视图（零拷贝），仅在类型不匹配时转换。
    let bytes;
    if (data instanceof Uint8Array && dtype !== 'int8' && dtype !== 'uint8' && dtype !== 'bool') {
        // 允许调用方直接传字节
        bytes = data;
    } else if (ArrayBuffer.isView(data)) {
        const expected = meta.Ctor;
        if (data.constructor === expected) {
            bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        } else {
            // 类型不匹配（例如 float16 收到 Float32Array）→ 走数值转换
            bytes = convertNumericToBytes(data, dtype, meta);
        }
    } else if (Array.isArray(data)) {
        bytes = convertNumericToBytes(data, dtype, meta);
    } else {
        throw new Error(`tensorCodec: unsupported data container ${Object.prototype.toString.call(data)}`);
    }

    const elementCount = shape.reduce((a, b) => a * Math.max(0, b), 1);
    if (bytes.byteLength !== elementCount * meta.bytes) {
        throw new Error(
            `tensorCodec: payload size mismatch for dtype ${dtype} shape [${shape}] — ` +
            `got ${bytes.byteLength} bytes, expected ${elementCount * meta.bytes}`
        );
    }
    return { dtype, shape, bytes };
}

/** 数值数组 → dtype 字节（含 int64 的 BigInt 处理） */
function convertNumericToBytes(data, dtype, meta) {
    const n = data.length;
    const out = new meta.Ctor(n);
    if (meta.Ctor === BigInt64Array) {
        for (let i = 0; i < n; i++) out[i] = BigInt(data[i]);
    } else if (meta.Ctor === BigUint64Array) {
        for (let i = 0; i < n; i++) out[i] = BigInt(data[i]);
    } else {
        for (let i = 0; i < n; i++) out[i] = data[i];
    }
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/**
 * 编码运行请求帧。
 * @param {string} modelId
 * @param {Object<string, object>} inputs - name → tensor-like
 * @returns {Uint8Array}
 */
export function encodeRunFrame(modelId, inputs) {
    const metas = [];
    const chunks = [];
    let offset = 0;
    for (const [name, tensor] of Object.entries(inputs)) {
        const { dtype, shape, bytes } = tensorToBytes({ ...tensor, name });
        metas.push({ name, dtype, shape, offset, length: bytes.byteLength });
        chunks.push(bytes);
        offset += bytes.byteLength;
    }
    const headerBytes = textEncoder.encode(JSON.stringify({ v: FRAME_VERSION, modelId, inputs: metas }));
    const frame = new Uint8Array(4 + headerBytes.byteLength + offset);
    new DataView(frame.buffer).setUint32(0, headerBytes.byteLength, true);
    frame.set(headerBytes, 4);
    let pos = 4 + headerBytes.byteLength;
    for (const c of chunks) {
        frame.set(c, pos);
        pos += c.byteLength;
    }
    return frame;
}

/**
 * 解码运行响应帧为张量样对象映射（name → {data, dims, type, dispose}）。
 * 输出 TypedArray 是帧 buffer 上的视图——调用方若长期持有应自行 slice。
 * @param {Uint8Array|ArrayBuffer|number[]} frameInput
 * @returns {Object<string, {data: TypedArray, dims: number[], type: string, dispose: Function}>}
 */
export function decodeRunFrame(frameInput) {
    let frame;
    if (frameInput instanceof ArrayBuffer) {
        frame = new Uint8Array(frameInput);
    } else if (frameInput instanceof Uint8Array) {
        frame = frameInput;
    } else if (Array.isArray(frameInput)) {
        frame = new Uint8Array(frameInput);
    } else {
        throw new Error(`tensorCodec: cannot decode frame of type ${typeof frameInput}`);
    }
    if (frame.byteLength < 4) throw new Error(`tensorCodec: frame too small (${frame.byteLength})`);
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const headerLen = view.getUint32(0, true);
    if (frame.byteLength < 4 + headerLen) {
        throw new Error(`tensorCodec: truncated frame (header ${headerLen}, total ${frame.byteLength})`);
    }
    const header = JSON.parse(textDecoder.decode(frame.subarray(4, 4 + headerLen)));
    if (header.v !== FRAME_VERSION) throw new Error(`tensorCodec: unsupported version ${header.v}`);
    const blobStart = 4 + headerLen;

    const outputs = {};
    for (const meta of header.outputs || []) {
        const typeMeta = DTYPE_META[meta.dtype];
        if (!typeMeta) throw new Error(`tensorCodec: unsupported output dtype '${meta.dtype}'`);
        const start = blobStart + meta.offset;
        const end = start + meta.length;
        if (end > frame.byteLength) {
            throw new Error(`tensorCodec: output '${meta.name}' range exceeds frame`);
        }
        // 拷贝到独立 buffer：BigInt64Array 等要求 8 字节对齐，帧内偏移不保证对齐
        const copy = frame.slice(start, end);
        const data = new typeMeta.Ctor(copy.buffer, copy.byteOffset, meta.length / typeMeta.bytes);
        outputs[meta.name] = {
            data,
            dims: meta.shape,
            type: meta.dtype,
            // 与 onnxruntime-web Tensor.dispose 对齐的 no-op（原生侧资源随响应释放）
            dispose() {},
        };
    }
    return outputs;
}

// --------------------------- base64（Android 传输路径） ---------------------------

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
    const t = new Int16Array(256).fill(-1);
    for (let i = 0; i < B64_CHARS.length; i++) t[B64_CHARS.charCodeAt(i)] = i;
    return t;
})();

/** Uint8Array → base64（分块避免栈溢出） */
export function bytesToBase64(bytes) {
    let out = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(out);
}

/** base64 → Uint8Array（查表解码，比 atob+charCodeAt 循环快） */
export function base64ToBytes(b64) {
    const len = b64.length;
    let padding = 0;
    if (len > 0 && b64[len - 1] === '=') padding++;
    if (len > 1 && b64[len - 2] === '=') padding++;
    const outLen = (len * 3) / 4 - padding;
    const out = new Uint8Array(outLen);
    let acc = 0, accBits = 0, j = 0;
    for (let i = 0; i < len; i++) {
        const v = B64_LOOKUP[b64.charCodeAt(i)];
        if (v < 0) continue;
        acc = (acc << 6) | v;
        accBits += 6;
        if (accBits >= 8) {
            accBits -= 8;
            if (j < outLen) out[j++] = (acc >> accBits) & 0xff;
        }
    }
    return out;
}
