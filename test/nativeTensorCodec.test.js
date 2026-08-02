/**
 * tensorCodec 二进制张量帧编解码测试
 * （与 Rust 侧 src-tauri/src/inference/frame.rs 的测试互为镜像）
 */
const { expect } = require('chai');

describe('nativeTensorCodec', () => {
  let codec;

  before(() => {
    codec = require('../src/inference/native/tensorCodec.js');
  });

  describe('tensorToBytes', () => {
    it('float32 张量 → 字节视图', () => {
      const data = new Float32Array([1.5, -2.5, 0.25, 4]);
      const { dtype, shape, bytes } = codec.tensorToBytes({ data, dims: [2, 2], type: 'float32' });
      expect(dtype).to.equal('float32');
      expect(shape).to.deep.equal([2, 2]);
      expect(bytes.byteLength).to.equal(16);
      const back = new Float32Array(bytes.buffer, bytes.byteOffset, 4);
      expect(Array.from(back)).to.deep.equal([1.5, -2.5, 0.25, 4]);
    });

    it('int64 张量（BigInt64Array）', () => {
      const data = new BigInt64Array([5n, -7n]);
      const { bytes } = codec.tensorToBytes({ data, dims: [2], type: 'int64' });
      expect(bytes.byteLength).to.equal(16);
    });

    it('float16 以 Uint16Array 承载', () => {
      const data = new Uint16Array([0x3c00, 0xc000]); // 1.0, -2.0
      const { bytes, dtype } = codec.tensorToBytes({ data, dims: [2], type: 'float16' });
      expect(dtype).to.equal('float16');
      expect(bytes.byteLength).to.equal(4);
    });

    it('普通数值数组可转换', () => {
      const { bytes } = codec.tensorToBytes({ data: [1, 2, 3, 4], dims: [4], type: 'int32' });
      expect(bytes.byteLength).to.equal(16);
    });

    it('int64 普通数组 → BigInt 转换', () => {
      const { bytes } = codec.tensorToBytes({ data: [1, 2], dims: [2], type: 'int64' });
      const back = new BigInt64Array(bytes.buffer, bytes.byteOffset, 2);
      expect(back[0]).to.equal(1n);
      expect(back[1]).to.equal(2n);
    });

    it('形状与字节数不匹配时报错', () => {
      expect(() => codec.tensorToBytes({ data: new Float32Array(3), dims: [2, 2], type: 'float32' }))
        .to.throw(/payload size mismatch/);
    });

    it('不支持的 dtype 报错', () => {
      expect(() => codec.tensorToBytes({ data: new Uint8Array(2), dims: [2], type: 'complex64' }))
        .to.throw(/unsupported dtype/);
    });
  });

  describe('encodeRunFrame / decodeRunFrame', () => {
    it('多输入帧编解码往返一致', () => {
      const inputs = {
        input_ids: { data: new BigInt64Array([10n, 20n, 30n]), dims: [1, 3], type: 'int64' },
        xt_input: { data: new Float32Array([0.5, 1.5, -0.5, 2.0]), dims: [1, 2, 2], type: 'float32' },
        mel16: { data: new Uint16Array([0x3c00, 0x4000]), dims: [2], type: 'float16' },
      };
      const frame = codec.encodeRunFrame('diffStep', inputs);
      expect(frame).to.be.instanceOf(Uint8Array);

      // 手工解析 header 验证布局
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      const headerLen = view.getUint32(0, true);
      const header = JSON.parse(new TextDecoder().decode(frame.subarray(4, 4 + headerLen)));
      expect(header.v).to.equal(1);
      expect(header.modelId).to.equal('diffStep');
      expect(header.inputs).to.have.lengthOf(3);
      expect(header.inputs[0].name).to.equal('input_ids');
      expect(header.inputs[0].dtype).to.equal('int64');
      expect(header.inputs[0].offset).to.equal(0);
      expect(header.inputs[1].offset).to.equal(24); // 3 * 8

      // 响应用同一格式（decodeRunFrame 解 outputs 头）
      const respHeader = { v: 1, outputs: header.inputs.map(m => ({ ...m })) };
      const hb = new TextEncoder().encode(JSON.stringify(respHeader));
      const blob = frame.subarray(4 + headerLen);
      const resp = new Uint8Array(4 + hb.length + blob.length);
      new DataView(resp.buffer).setUint32(0, hb.length, true);
      resp.set(hb, 4);
      resp.set(blob, 4 + hb.length);

      const outputs = codec.decodeRunFrame(resp);
      expect(Object.keys(outputs)).to.have.lengthOf(3);
      expect(Array.from(outputs.xt_input.data)).to.deep.equal([0.5, 1.5, -0.5, 2.0]);
      expect(outputs.xt_input.dims).to.deep.equal([1, 2, 2]);
      expect(outputs.xt_input.type).to.equal('float32');
      expect(outputs.input_ids.data[2]).to.equal(30n);
      expect(outputs.mel16.data[1]).to.equal(0x4000);
      expect(() => outputs.xt_input.dispose()).to.not.throw();
    });

    it('接受 ArrayBuffer / number[] 形式的帧', () => {
      const frame = codec.encodeRunFrame('m', { a: { data: new Float32Array([1]), dims: [1], type: 'float32' } });
      // 构造 outputs 帧
      const hb = new TextEncoder().encode(JSON.stringify({ v: 1, outputs: [{ name: 'y', dtype: 'float32', shape: [1], offset: 0, length: 4 }] }));
      const resp = new Uint8Array(4 + hb.length + 4);
      new DataView(resp.buffer).setUint32(0, hb.length, true);
      resp.set(hb, 4);
      resp.set(new Uint8Array([0, 0, 128, 63]), 4 + hb.length); // 1.0f
      const fromBuf = codec.decodeRunFrame(resp.buffer);
      expect(fromBuf.y.data[0]).to.equal(1.0);
      const fromArr = codec.decodeRunFrame(Array.from(resp));
      expect(fromArr.y.data[0]).to.equal(1.0);
    });

    it('截断帧报错', () => {
      expect(() => codec.decodeRunFrame(new Uint8Array([1, 0]))).to.throw(/too small/);
      expect(() => codec.decodeRunFrame(new Uint8Array([100, 0, 0, 0, 1, 2]))).to.throw(/truncated/);
    });
  });

  describe('base64', () => {
    it('bytesToBase64 / base64ToBytes 往返（含大缓冲）', () => {
      const n = 100000;
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = (i * 7 + 13) & 0xff;
      const b64 = codec.bytesToBase64(bytes);
      const back = codec.base64ToBytes(b64);
      expect(back.length).to.equal(n);
      expect(back[0]).to.equal(bytes[0]);
      expect(back[99999]).to.equal(bytes[99999]);
    });

    it('base64ToBytes 处理 padding', () => {
      expect(Array.from(codec.base64ToBytes('AQID'))).to.deep.equal([1, 2, 3]);
      expect(Array.from(codec.base64ToBytes('AQI='))).to.deep.equal([1, 2]);
      expect(Array.from(codec.base64ToBytes('AQ=='))).to.deep.equal([1]);
    });
  });
});
