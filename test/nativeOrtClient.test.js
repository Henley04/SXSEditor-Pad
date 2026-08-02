/**
 * nativeOrtClient 外观与会话代理测试（mock window.electronAPI）
 */
const { expect } = require('chai');
const sinon = require('sinon');

describe('nativeOrtClient', () => {
  let client, codec;

  before(() => {
    client = require('../src/inference/native/nativeOrtClient.js');
    codec = require('../src/inference/native/tensorCodec.js');
  });

  afterEach(() => {
    sinon.restore();
    delete window.electronAPI;
    client.__resetNativeBackendForTests();
    client.__resetPlatformForTests();
  });

  function mockApi(overrides = {}) {
    window.electronAPI = {
      nativeOrtInit: sinon.stub().resolves({ available: true, libPath: '/lib/libonnxruntime.so', accelerators: { nnapi: true, coreml: false } }),
      nativeOrtLoadModel: sinon.stub().resolves({
        success: true,
        ep: 'nnapi+cpu',
        inputs: [{ name: 'input_ids', dtype: 'int64' }],
        outputs: [{ name: 'embeddings', dtype: 'float32' }],
      }),
      nativeOrtUnloadModel: sinon.stub().resolves({ unloaded: true }),
      nativeOrtStatus: sinon.stub().resolves({ available: true, sessions: [] }),
      nativeOrtDetectAccelerators: sinon.stub().resolves({ nnapi: true, coreml: false }),
      getPlatformInfo: sinon.stub().resolves({ platform: 'linux', isMobile: false }),
      ...overrides,
    };
  }

  describe('tryInitNativeBackend', () => {
    it('原生可用时返回 facade（Tensor/InferenceSession/env）', async () => {
      mockApi();
      const ort = await client.tryInitNativeBackend();
      expect(ort).to.not.equal(null);
      expect(ort.__isNativeFacade).to.equal(true);
      expect(ort.Tensor).to.equal(client.NativeTensor);
      expect(ort.InferenceSession).to.equal(client.NativeInferenceSession);
      expect(ort.env.wasm).to.be.an('object');
    });

    it('无 electronAPI 时返回 null（浏览器回退）', async () => {
      const ort = await client.tryInitNativeBackend();
      expect(ort).to.equal(null);
    });

    it('原生库缺失时返回 null 并缓存失败', async () => {
      mockApi({ nativeOrtInit: sinon.stub().resolves({ available: false, error: 'lib not found' }) });
      const first = await client.tryInitNativeBackend();
      expect(first).to.equal(null);
      const second = await client.tryInitNativeBackend();
      expect(second).to.equal(null);
      expect(window.electronAPI.nativeOrtInit.callCount).to.equal(1); // 缓存
    });
  });

  describe('epToDevicePreference', () => {
    it('webnn-npu → npu；webnn-gpu → gpu；wasm/缺省 → cpu', () => {
      expect(client.epToDevicePreference([{ name: 'webnn', deviceType: 'npu' }])).to.equal('npu');
      expect(client.epToDevicePreference([{ name: 'webnn', deviceType: 'gpu' }])).to.equal('gpu');
      expect(client.epToDevicePreference(['wasm'])).to.equal('cpu');
      expect(client.epToDevicePreference(undefined)).to.equal('cpu');
    });
  });

  describe('NativeInferenceSession', () => {
    it('create 透传模型路径/选项并暴露元数据', async () => {
      mockApi();
      client.__setNativeAvailableForTests(true);
      const session = await client.NativeInferenceSession.create(new ArrayBuffer(0), {
        __modelPath: '/models/note_text_encoder.onnx',
        __modelId: 'noteTextEncoder',
        graphOptimizationLevel: 'basic',
        executionProviders: [{ name: 'webnn', deviceType: 'npu' }],
      });
      expect(window.electronAPI.nativeOrtLoadModel.calledOnce).to.equal(true);
      const [id, path, opts] = window.electronAPI.nativeOrtLoadModel.firstCall.args;
      expect(id).to.equal('noteTextEncoder');
      expect(path).to.equal('/models/note_text_encoder.onnx');
      expect(opts.devicePreference).to.equal('npu');
      expect(opts.graphOptimizationLevel).to.equal('basic');
      expect(session.inputNames).to.deep.equal(['input_ids']);
      expect(session.outputNames).to.deep.equal(['embeddings']);
      expect(session.inputMetadata[0].type).to.equal('int64');
    });

    it('缺少 __modelPath 时报错', async () => {
      mockApi();
      await expectAsyncThrow(() => client.NativeInferenceSession.create(new ArrayBuffer(0), {}));
    });

    it('run 经二进制帧传输（桌面路径），返回张量样输出', async () => {
      // 构造假的 Rust 响应帧：echo 一个 float32 [1,2] 输出
      const outBytes = new Float32Array([3.25, -1.5]);
      const hb = new TextEncoder().encode(JSON.stringify({
        v: 1,
        outputs: [{ name: 'embeddings', dtype: 'float32', shape: [1, 2], offset: 0, length: 8 }],
      }));
      const frame = new Uint8Array(4 + hb.length + 8);
      new DataView(frame.buffer).setUint32(0, hb.length, true);
      frame.set(hb, 4);
      frame.set(new Uint8Array(outBytes.buffer), 4 + hb.length);

      mockApi({
        nativeOrtRun: sinon.stub().callsFake(async (payload) => {
          expect(payload).to.be.instanceOf(Uint8Array);
          return frame.buffer; // ArrayBuffer 响应
        }),
      });
      client.__setNativeAvailableForTests(true);
      client.__setPlatformForTests({ platform: 'linux', isMobile: false });

      const session = await client.NativeInferenceSession.create(new ArrayBuffer(0), {
        __modelPath: '/m.onnx', __modelId: 'm1',
      });
      const feeds = { input_ids: new client.NativeTensor('int64', new BigInt64Array([7n]), [1, 1]) };
      const results = await session.run(feeds);
      expect(results.embeddings.type).to.equal('float32');
      expect(results.embeddings.dims).to.deep.equal([1, 2]);
      expect(Array.from(results.embeddings.data)).to.deep.equal([3.25, -1.5]);
      expect(() => results.embeddings.dispose()).to.not.throw();
    });

    it('Android 平台走 base64 传输路径', async () => {
      const outBytes = new Float32Array([42]);
      const hb = new TextEncoder().encode(JSON.stringify({
        v: 1, outputs: [{ name: 'embeddings', dtype: 'float32', shape: [1], offset: 0, length: 4 }],
      }));
      const frame = new Uint8Array(4 + hb.length + 4);
      new DataView(frame.buffer).setUint32(0, hb.length, true);
      frame.set(hb, 4);
      frame.set(new Uint8Array(outBytes.buffer), 4 + hb.length);

      mockApi({
        nativeOrtRunB64: sinon.stub().resolves({ frameB64: codec.bytesToBase64(frame) }),
      });
      client.__setNativeAvailableForTests(true);
      client.__setPlatformForTests({ platform: 'android', isMobile: true });

      const session = await client.NativeInferenceSession.create(new ArrayBuffer(0), {
        __modelPath: '/m.onnx', __modelId: 'm2',
      });
      const results = await session.run({ input_ids: { data: new BigInt64Array([1n]), dims: [1, 1], type: 'int64' } });
      expect(window.electronAPI.nativeOrtRunB64.calledOnce).to.equal(true);
      expect(window.electronAPI.nativeOrtRun.callCount).to.equal(0);
      expect(Array.from(results.embeddings.data)).to.deep.equal([42]);
    });

    it('release 卸载模型且幂等；run 于 release 后报错', async () => {
      mockApi();
      client.__setNativeAvailableForTests(true);
      const session = await client.NativeInferenceSession.create(new ArrayBuffer(0), {
        __modelPath: '/m.onnx', __modelId: 'm3',
      });
      await session.release();
      await session.release();
      expect(window.electronAPI.nativeOrtUnloadModel.calledOnce).to.equal(true);
      expect(window.electronAPI.nativeOrtUnloadModel.firstCall.args[0]).to.equal('m3');
      await expectAsyncThrow(() => session.run({}));
    });
  });

  describe('detectNativeAccelerators', () => {
    it('nnapi 可用 → npu/gpu true', async () => {
      mockApi();
      const acc = await client.detectNativeAccelerators();
      expect(acc.npu).to.equal(true);
      expect(acc.cpu).to.equal(true);
    });

    it('无桥接时安全回退', async () => {
      const acc = await client.detectNativeAccelerators();
      expect(acc.npu).to.equal(false);
      expect(acc.cpu).to.equal(true);
    });
  });
});

async function expectAsyncThrow(fn) {
  let threw = false;
  try { await fn(); } catch (_) { threw = true; }
  if (!threw) throw new Error('expected function to throw');
}
