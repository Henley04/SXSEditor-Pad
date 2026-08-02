/**
 * rmvpeNative / basicPitchNative 纯逻辑测试
 */
const { expect } = require('chai');

describe('rmvpeNative', () => {
  let rmvpe;

  before(() => {
    rmvpe = require('../src/inference/native/rmvpeNative.js');
  });

  describe('interpolateF0', () => {
    it('空输入 → 全零', () => {
      const out = rmvpe.interpolateF0(new Float32Array(0), 16000, 16000, 24000, 480);
      expect(out.length).to.be.greaterThan(0);
      expect(Array.from(out)).to.deep.equal(new Array(out.length).fill(0));
    });

    it('恒定 F0 插值后仍为恒定值', () => {
      const raw = new Float32Array(100).fill(440);
      const out = rmvpe.interpolateF0(raw, 16000 * 2, 16000, 24000, 480);
      // 2 秒 → floor(2*24000/480) = 100 帧（受原长限制）
      for (let i = 0; i < 10; i++) {
        expect(out[i]).to.be.closeTo(440, 0.5);
      }
    });

    it('线性斜坡插值单调', () => {
      const raw = new Float32Array(200);
      for (let i = 0; i < raw.length; i++) raw[i] = 100 + i;
      const out = rmvpe.interpolateF0(raw, 16000 * 2, 16000, 24000, 480);
      let prev = -1;
      for (let i = 0; i < out.length && out[i] > 0; i++) {
        expect(out[i]).to.be.at.least(prev);
        prev = out[i];
      }
    });
  });

  describe('decodePitchOutput', () => {
    it('argmax 选择正确的类别并映射到 F0', () => {
      const T = 3;
      const pitch = new Float32Array(T * 2560);
      // 第 0 帧：类别 0 → F0_MIN(30)；第 1 帧：类别 2559 → F0_MAX(7600)
      pitch[0 * 2560 + 0] = 10;
      pitch[1 * 2560 + 2559] = 10;
      pitch[2 * 2560 + 1280] = 10;
      const out = rmvpe.decodePitchOutput(pitch, T, 16000);
      expect(out[0]).to.be.closeTo(30, 0.01);
      // 后续帧插值过渡，应在 30..7600 之间
      for (let i = 0; i < out.length; i++) {
        expect(out[i]).to.be.within(0, 7600);
      }
    });
  });
});

describe('basicPitchNative', () => {
  let bpn, pp;

  before(() => {
    bpn = require('../src/inference/native/basicPitchNative.js');
    pp = require('../src/inference/basicPitchPostprocess.js');
  });

  describe('frameAudio', () => {
    it('按 AUDIO_N_SAMPLES / HOP_SIZE 分帧并前补零', () => {
      const sr = pp.BASIC_PITCH_SAMPLE_RATE;
      // 3 秒音频
      const audio = new Float32Array(sr * 3);
      for (let i = 0; i < audio.length; i++) audio[i] = Math.sin(i / 100);
      const { frames, nOutputFramesOriginal } = bpn.frameAudio(audio);
      expect(frames.length).to.be.greaterThan(1);
      expect(frames[0].length).to.equal(pp.AUDIO_N_SAMPLES);
      expect(nOutputFramesOriginal).to.equal(Math.floor(audio.length * (pp.ANNOTATIONS_FPS / sr)));
      // 前补零：第一帧前 padLen 个采样为 0
      const padLen = Math.floor(pp.OVERLAP_LENGTH_FRAMES / 2);
      expect(frames[0][0]).to.equal(0);
      expect(frames[0][padLen - 1]).to.equal(0);
      expect(frames[0][padLen]).to.equal(audio[0]);
    });

    it('极短音频仍产生一窗（零填充）', () => {
      const { frames } = bpn.frameAudio(new Float32Array(100));
      expect(frames.length).to.equal(1);
      expect(frames[0].length).to.equal(pp.AUDIO_N_SAMPLES);
    });
  });

  describe('postprocessModelOutputs 集成', () => {
    it('强 onset + 持续帧能量 → 检出音符', () => {
      const F = 40;
      const frames = [];
      const onsets = [];
      const contours = [];
      for (let t = 0; t < F; t++) {
        const fr = new Float32Array(88);
        const on = new Float32Array(88);
        const co = new Float32Array(264);
        const midiBin = 60 - 21; // MIDI 60 → bin 39
        if (t >= 5 && t < 25) fr[midiBin] = 0.9;
        if (t === 5) on[midiBin] = 0.95;
        const contourBin = Math.round(12 * Math.log2(pp.midiToHz(60) / 27.5));
        if (t >= 5 && t < 25) co[contourBin] = 0.9;
        frames.push(fr); onsets.push(on); contours.push(co);
      }
      const { notes, f0Array } = pp.postprocessModelOutputs(frames, onsets, contours, 120);
      expect(notes.length).to.be.greaterThan(0);
      expect(notes[0].pitch).to.equal(60);
      expect(f0Array.length).to.be.greaterThan(0);
    });

    it('全零输入 → 无音符', () => {
      const zero = (n) => new Float32Array(n);
      const rows = (r, c) => Array.from({ length: r }, () => zero(c));
      const { notes } = pp.postprocessModelOutputs(rows(10, 88), rows(10, 88), rows(10, 264), 120);
      expect(notes).to.deep.equal([]);
    });
  });
});
