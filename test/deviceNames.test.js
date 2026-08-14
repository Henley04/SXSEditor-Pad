const { expect } = require('chai');

describe('deviceNames', () => {
  let mod;
  before(() => {
    mod = require('../src/utils/deviceNames');
  });

  describe('getCPUName', () => {
    it('prefers the native-reported SoC name', () => {
      expect(mod.getCPUName({ cpuName: 'Snapdragon 8 Gen 3' })).to.equal('Snapdragon 8 Gen 3');
      expect(mod.getCPUName({ cpuName: 'Apple M2' })).to.equal('Apple M2');
    });

    it('extracts the Android device model from the UA platform block', () => {
      global.navigator = { userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S928B Build/UP1A) AppleWebKit/537.36' };
      expect(mod.getCPUName({})).to.equal('SM-S928B');
    });

    it('extracts iPhone from the UA platform block', () => {
      global.navigator = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15' };
      expect(mod.getCPUName({})).to.equal('iPhone');
    });

    it('extracts Intel Mac CPU and strips the OS suffix', () => {
      global.navigator = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };
      expect(mod.getCPUName({})).to.equal('Intel');
    });

    it('extracts Windows NT version', () => {
      global.navigator = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
      expect(mod.getCPUName({})).to.equal('Windows NT 10.0');
    });

    it('does NOT report AppleWebKit as the CPU', () => {
      global.navigator = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0' };
      const name = mod.getCPUName({});
      expect(name).to.not.match(/AppleWebKit/i);
    });

    it('falls back to core count when UA has no recognizable CPU', () => {
      global.navigator = { userAgent: '', hardwareConcurrency: 8 };
      expect(mod.getCPUName({})).to.equal('8 核 CPU');
    });
  });

  describe('getGPUName', () => {
    it('prefers the native-reported GPU name', () => {
      expect(mod.getGPUName({ gpuName: 'Adreno 750' })).to.equal('Adreno 750');
    });

    it('labels the accelerator row via CoreML/NNAPI when no real name', () => {
      expect(mod.getGPUName({ accelerators: { coreml: true } })).to.equal('CoreML (ANE/GPU)');
      expect(mod.getGPUName({ accelerators: { nnapi: true } })).to.equal('NNAPI (GPU/DSP)');
    });

    it('falls back to a plain GPU token, never "WebGL GPU"', () => {
      global.document = undefined;
      expect(mod.getGPUName({})).to.equal('GPU');
    });
  });

  describe('acceleratorLabel', () => {
    it('names CoreML EPs', () => {
      expect(mod.acceleratorLabel({ accelerators: { coreml: true } }, 'NPU')).to.equal('CoreML (ANE)');
      expect(mod.acceleratorLabel({ accelerators: { coreml: true } }, 'DSP')).to.equal('CoreML');
    });

    it('names NNAPI EPs', () => {
      expect(mod.acceleratorLabel({ accelerators: { nnapi: true } }, 'NPU')).to.equal('NNAPI');
      expect(mod.acceleratorLabel({ accelerators: { nnapi: true } }, 'DSP')).to.equal('NNAPI (Hexagon/QDSP)');
    });

    it('falls back to the kind token', () => {
      expect(mod.acceleratorLabel({}, 'GPU')).to.equal('GPU');
      expect(mod.acceleratorLabel(null, 'NPU')).to.equal('NPU');
    });
  });
});