const path = require('node:path');
const tf = require('@tensorflow/tfjs');
require('@tensorflow/tfjs-backend-wasm');
const { resampleAudio } = require('../utils/resampleAudio');
// 纯后处理逻辑与常量集中在 basicPitchPostprocess.js（浏览器/Node 共用）；
// 本文件仅保留 TF.js 模型执行部分（Electron 主进程路径）。
const pp = require('./basicPitchPostprocess');

const {
  gaussian, argMax, argMaxAxis1, whereGreaterThanAxis1, meanStdDev, globalMax,
  midiToHz, hzToMidi,
} = pp;

const BASIC_PITCH_SAMPLE_RATE = pp.BASIC_PITCH_SAMPLE_RATE;
const CONTOUR_BINS_PER_SEMITONE = pp.CONTOUR_BINS_PER_SEMITONE;
const ANNOTATIONS_FPS = pp.ANNOTATIONS_FPS;
const AUDIO_N_SAMPLES = pp.AUDIO_N_SAMPLES;
const N_OVERLAP_OVER_2 = pp.N_OVERLAP_OVER_2;
const OVERLAP_LENGTH_FRAMES = pp.OVERLAP_LENGTH_FRAMES;
const HOP_SIZE = pp.HOP_SIZE;
const N_FREQ_BINS_CONTOURS = pp.N_FREQ_BINS_CONTOURS;
const outputToNotesPoly = pp.outputToNotesPoly;
const noteFramesToTime = pp.noteFramesToTime;
const addPitchBendsToNoteEvents = pp.addPitchBendsToNoteEvents;

let _noteIdCounter = 0;

/**
 * Convert a 2D tensor to an array of Float32Array rows (subarray views into
 * a single flat TypedArray returned by dataSync()).
 *
 * This replaces tensor.arraySync() which builds nested JS arrays (slow, many
 * small allocations). dataSync() returns a flat Float32Array in a single
 * bulk transfer; subarray views provide O(1) row access with zero copying.
 *
 * The returned rows are VIEWS into the underlying buffer — modifications to a
 * row mutate the buffer. Callers that need a copy should use row.slice().
 */
function tensorTo2DRows(tensor, numCols) {
  const flatData = tensor.dataSync();
  const numRows = Math.floor(flatData.length / numCols);
  const rows = new Array(numRows);
  for (let r = 0; r < numRows; r++) {
    rows[r] = flatData.subarray(r * numCols, (r + 1) * numCols);
  }
  return rows;
}

class BasicPitchDetector {
  constructor(modelDir) {
    this.modelDir = modelDir;
    this.model = null;
    this.initialized = false;
    this._server = null;
    this._serverPort = null;
  }

  _startLocalServer() {
    return new Promise((resolve, reject) => {
      const http = require('http');
      const fs = require('fs');
      const modelPath = path.join(this.modelDir, 'basic_pitch_model');

      const contentTypeMap = {
        '.json': 'application/json',
        '.bin': 'application/octet-stream',
      };

      const server = http.createServer((req, res) => {
        const filePath = path.resolve(modelPath, req.url.replace(/^\//, ''));
        // 防止路径遍历攻击
        if (!filePath.startsWith(path.resolve(modelPath) + path.sep) && filePath !== path.resolve(modelPath)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
        if (!fs.existsSync(filePath)) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const ext = path.extname(filePath);
        const contentType = contentTypeMap[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        fs.createReadStream(filePath).pipe(res);
      });

      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        this._serverPort = address.port;
        resolve(`http://127.0.0.1:${address.port}`);
      });

      server.on('error', reject);
      this._server = server;
    });
  }

  async init() {
    if (this.initialized) return true;

    // 设置 WASM 后端以加速推理
    try {
      await tf.setBackend('wasm');
      await tf.ready();
      console.log('[BasicPitchDetector] TF.js backend set to WASM');
    } catch (e) {
      console.warn('[BasicPitchDetector] WASM backend init failed, falling back to CPU backend:', e.message);
      await tf.setBackend('cpu');
      await tf.ready();
    }

    const modelPath = path.join(this.modelDir, 'basic_pitch_model');
    console.log('[BasicPitchDetector] attempting to load model:', modelPath);

    const fs = require('fs');
    const modelJsonPath = path.join(modelPath, 'model.json');
    if (!fs.existsSync(modelJsonPath)) {
      const errMsg = `[BasicPitchDetector] model file does not exist: ${modelJsonPath}`;
      console.error(errMsg);
      const err = new Error(errMsg);
      err.code = 'MODEL_NOT_FOUND';
      err.modelPath = modelJsonPath;
      throw err;
    }

    const baseUrl = await this._startLocalServer();
    try {
      this.model = await tf.loadGraphModel(`${baseUrl}/model.json`);
      this.initialized = true;
      console.log('[BasicPitchDetector] model loaded successfully');
      return true;
    } catch (err) {
      console.error('[BasicPitchDetector] model load failed:', err.message);
      if (this._server) { this._server.close(); this._server = null; this._serverPort = null; }
      err.modelPath = modelJsonPath;
      throw err;
    }
  }

  dispose() {
    if (this._server) {
      this._server.close();
      this._server = null;
      this._serverPort = null;
    }
    if (this.model) {
      this.model.dispose();
      this.model = null;
    }
    this.initialized = false;
  }

  resampleAudio(audioData, fromSampleRate, toSampleRate) {
    const ratio = fromSampleRate / toSampleRate;
    const newLength = Math.floor(audioData.length / ratio);
    const resampled = new Float32Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const srcIndex = i * ratio;
      const srcIndexInt = Math.floor(srcIndex);
      const frac = srcIndex - srcIndexInt;

      if (srcIndexInt + 1 < audioData.length) {
        resampled[i] = audioData[srcIndexInt] * (1 - frac) + audioData[srcIndexInt + 1] * frac;
      } else {
        resampled[i] = audioData[srcIndexInt] || 0;
      }
    }

    return resampled;
  }

  async extractF0AndNotes(audioData, sampleRate = 44100, bpm = 120) {
    if (!this.initialized) {
      await this.init();
    }

    const resampledAudio = sampleRate !== BASIC_PITCH_SAMPLE_RATE
      ? resampleAudio(audioData, sampleRate, BASIC_PITCH_SAMPLE_RATE)
      : audioData;

    const wavSamples = tf.concat1d([
      tf.zeros([Math.floor(OVERLAP_LENGTH_FRAMES / 2)], 'float32'),
      tf.tensor1d(resampledAudio, 'float32'),
    ]);

    const reshapedInput = tf.expandDims(
      tf.signal.frame(wavSamples, AUDIO_N_SAMPLES, HOP_SIZE, true, 0),
      -1
    );

    const audioOriginalLength = resampledAudio.length;
    const nOutputFramesOriginal = Math.floor(audioOriginalLength * (ANNOTATIONS_FPS / BASIC_PITCH_SAMPLE_RATE));

    const allFrames = [];
    const allOnsets = [];
    const allContours = [];
    let calculatedFrames = 0;

    const batchSize = reshapedInput.shape[0];

    try {
      for (let i = 0; i < batchSize; ++i) {
        console.log(`[BasicPitchDetector] processing frame: ${i + 1}/${batchSize}`);

        const singleBatch = tf.slice(reshapedInput, [i, 0, 0], [1, -1, -1]);
        const model = await this.model;
        const results = model.execute(singleBatch, ['Identity_1', 'Identity_2', 'Identity']);

        let unwrappedResultingFrames = this.unwrapOutput(results[0]);
        let unwrappedResultingOnsets = this.unwrapOutput(results[1]);
        let unwrappedResultingContours = this.unwrapOutput(results[2]);

        const calculatedFramesTmp = unwrappedResultingFrames.shape[0];

        if (calculatedFrames >= nOutputFramesOriginal) {
          singleBatch.dispose();
          results.forEach(t => t.dispose());
          unwrappedResultingFrames.dispose();
          unwrappedResultingOnsets.dispose();
          unwrappedResultingContours.dispose();
          continue;
        }

        if (calculatedFramesTmp + calculatedFrames >= nOutputFramesOriginal) {
          const framesToOutput = nOutputFramesOriginal - calculatedFrames;
          const slicedFrames = unwrappedResultingFrames.slice([0, 0], [framesToOutput, -1]);
          const slicedOnsets = unwrappedResultingOnsets.slice([0, 0], [framesToOutput, -1]);
          const slicedContours = unwrappedResultingContours.slice([0, 0], [framesToOutput, -1]);

          allFrames.push(tensorTo2DRows(slicedFrames, N_FREQ_BINS_CONTOURS));
          allOnsets.push(tensorTo2DRows(slicedOnsets, N_FREQ_BINS_CONTOURS));
          allContours.push(tensorTo2DRows(slicedContours, N_FREQ_BINS_CONTOURS));

          slicedFrames.dispose();
          slicedOnsets.dispose();
          slicedContours.dispose();
        } else {
          allFrames.push(tensorTo2DRows(unwrappedResultingFrames, N_FREQ_BINS_CONTOURS));
          allOnsets.push(tensorTo2DRows(unwrappedResultingOnsets, N_FREQ_BINS_CONTOURS));
          allContours.push(tensorTo2DRows(unwrappedResultingContours, N_FREQ_BINS_CONTOURS));
        }

        calculatedFrames += calculatedFramesTmp;

        singleBatch.dispose();
        results.forEach(t => t.dispose());
        unwrappedResultingFrames.dispose();
        unwrappedResultingOnsets.dispose();
        unwrappedResultingContours.dispose();
      }
    } finally {
      reshapedInput.dispose();
      wavSamples.dispose();
    }

    const frames = allFrames.flat();
    const onsets = allOnsets.flat();
    const contours = allContours.flat();

    const noteArray = outputToNotesPoly(frames, onsets, CONTOUR_BINS_PER_SEMITONE);
    const timeNoteArray = noteFramesToTime(noteArray);
    const noteEventsTime = addPitchBendsToNoteEvents(contours, timeNoteArray, CONTOUR_BINS_PER_SEMITONE);

    const adjustedNotes = noteEventsTime.map(note => ({
      startTimeSeconds: note.startTimeSeconds,
      durationSeconds: note.durationSeconds,
      pitch_midi: note.pitchMidi,
      amplitude: note.amplitude,
      pitchBends: note.pitchBends,
    }));

    const f0Array = this.notesToF0Array(adjustedNotes);
    const midiNotes = this.notesToMidiNotes(adjustedNotes, bpm);

    return {
      f0Array,
      notes: midiNotes,
    };
  }

  unwrapOutput(result) {
    let rawOutput = result;
    rawOutput = result.slice([0, N_OVERLAP_OVER_2, 0], [-1, result.shape[1] - 2 * N_OVERLAP_OVER_2, -1]);
    const outputShape = rawOutput.shape;
    return rawOutput.reshape([outputShape[0] * outputShape[1], outputShape[2]]);
  }

  notesToF0Array(notes) {
    const f0Array = [];
    const frameDuration = 1 / ANNOTATIONS_FPS;

    if (notes.length === 0) return f0Array;

    let lastTime = 0;
    for (const note of notes) {
      const startTime = note.startTimeSeconds;
      const duration = note.durationSeconds;
      const f0 = midiToHz(note.pitch_midi);

      while (lastTime < startTime) {
        f0Array.push({ time: lastTime, f0: 0 });
        lastTime += frameDuration;
      }

      const endTime = startTime + duration;
      while (lastTime < endTime) {
        f0Array.push({ time: lastTime, f0: f0 });
        lastTime += frameDuration;
      }
    }

    return f0Array;
  }

  notesToMidiNotes(notes, bpm) {
    const midiNotes = [];
    const beatDuration = 60 / bpm;

    for (const note of notes) {
      const start = note.startTimeSeconds / beatDuration;
      const duration = note.durationSeconds / beatDuration;
      const pitch = note.pitch_midi;

      if (pitch >= 24 && pitch <= 108) {
        midiNotes.push({
          id: ++_noteIdCounter,
          pitch,
          start,
          duration,
          lyric: 'la',
        });
      }
    }

    return midiNotes;
  }
}

module.exports = {
  BasicPitchDetector,
  BASIC_PITCH_SAMPLE_RATE,
  midiToHz,
  hzToMidi,
  gaussian,
  argMax,
  argMaxAxis1,
  whereGreaterThanAxis1,
  meanStdDev,
  globalMax,
};
