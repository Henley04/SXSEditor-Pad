/**
 * Basic Pitch 纯后处理逻辑（无 Node/TF 依赖）。
 *
 * 从 basicPitch.js 抽取，供两条执行路径共用：
 *   - Node/Electron 主进程：basicPitch.js（TF.js + 本地 HTTP 服务器）
 *   - 渲染器/移动端：inference/native/basicPitchNative.js（LiteRT 原生
 *     或 TF.js fromMemory）
 *
 * 所有函数保持与原实现逐行一致的行为（含 melodiaTrick 的列最大值优化）。
 */

let _noteIdCounter = 0;

const BASIC_PITCH_SAMPLE_RATE = 22050;
const CONTOUR_BINS_PER_SEMITONE = 1;
const ANNOTATIONS_FPS = Math.floor(BASIC_PITCH_SAMPLE_RATE / 256);
const AUDIO_WINDOW_LENGTH_SECONDS = 2;
const FFT_HOP = 256;
const AUDIO_N_SAMPLES = BASIC_PITCH_SAMPLE_RATE * AUDIO_WINDOW_LENGTH_SECONDS - FFT_HOP;
const N_OVERLAPPING_FRAMES = 30;
const N_OVERLAP_OVER_2 = Math.floor(N_OVERLAPPING_FRAMES / 2);
const OVERLAP_LENGTH_FRAMES = N_OVERLAPPING_FRAMES * FFT_HOP;
const HOP_SIZE = AUDIO_N_SAMPLES - OVERLAP_LENGTH_FRAMES;

const MIDI_OFFSET = 21;
const MAX_FREQ_IDX = 87;
const N_FREQ_BINS_CONTOURS = 88 * CONTOUR_BINS_PER_SEMITONE;

function gaussian(M, std) {
  const result = [];
  for (let n = 0; n < M; n++) {
    result.push(Math.exp((-1 * (n - (M - 1) / 2) ** 2) / (2 * std ** 2)));
  }
  return result;
}

function argMax(arr) {
  if (arr.length === 0) return null;
  let maxIndex = -1;
  for (let i = 0; i < arr.length; i++) {
    if (maxIndex === -1 || arr[i] > arr[maxIndex]) {
      maxIndex = i;
    }
  }
  return maxIndex;
}

function argMaxAxis1(arr) {
  return arr.map(row => argMax(row));
}

function whereGreaterThanAxis1(arr2d, threshold) {
  const outputX = [];
  const outputY = [];
  for (let i = 0; i < arr2d.length; i++) {
    for (let j = 0; j < arr2d[i].length; j++) {
      if (arr2d[i][j] > threshold) {
        outputX.push(i);
        outputY.push(j);
      }
    }
  }
  return [outputX, outputY];
}

function meanStdDev(array) {
  let sum = 0;
  let sumSquared = 0;
  let count = 0;
  for (const row of array) {
    for (const value of row) {
      sum += value;
      sumSquared += value * value;
      count++;
    }
  }
  const mean = sum / count;
  if (count <= 1) return [sum, 0];
  const std = Math.sqrt((1 / (count - 1)) * (sumSquared - (sum * sum) / count));
  return [mean, std];
}

function globalMax(array) {
  let max = 0;
  for (const row of array) {
    for (const v of row) {
      if (v > max) max = v;
    }
  }
  return max;
}

function min3dForAxis0(array) {
  const minArray = array[0].map(v => v.slice());
  for (let x = 1; x < array.length; ++x) {
    for (let y = 0; y < array[0].length; ++y) {
      for (let z = 0; z < array[0][0].length; ++z) {
        minArray[y][z] = Math.min(minArray[y][z], array[x][y][z]);
      }
    }
  }
  return minArray;
}

function max3dForAxis0(array) {
  const maxArray = array[0].map(v => v.slice());
  for (let x = 1; x < array.length; ++x) {
    for (let y = 0; y < array[0].length; ++y) {
      for (let z = 0; z < array[0][0].length; ++z) {
        maxArray[y][z] = Math.max(maxArray[y][z], array[x][y][z]);
      }
    }
  }
  return maxArray;
}

function argRelMax(array, order = 1) {
  const result = [];
  for (let col = 0; col < array[0].length; ++col) {
    for (let row = 0; row < array.length; ++row) {
      let isRelMax = true;
      for (
        let comparisonRow = Math.max(0, row - order);
        isRelMax && comparisonRow <= Math.min(array.length - 1, row + order);
        ++comparisonRow
      ) {
        if (comparisonRow !== row) {
          isRelMax = isRelMax && array[row][col] > array[comparisonRow][col];
        }
      }
      if (isRelMax) {
        result.push([row, col]);
      }
    }
  }
  return result;
}

function midiToHz(midi) {
  return 440.0 * 2.0 ** ((midi - 69.0) / 12.0);
}

function hzToMidi(hz) {
  return 12 * (Math.log2(hz) - Math.log2(440.0)) + 69;
}

function constrainFrequency(onsets, frames, maxFreq, minFreq) {
  if (maxFreq) {
    const maxFreqIdx = hzToMidi(maxFreq) - MIDI_OFFSET;
    for (let i = 0; i < onsets.length; i++) {
      onsets[i].fill(0, maxFreqIdx);
    }
    for (let i = 0; i < frames.length; i++) {
      frames[i].fill(0, maxFreqIdx);
    }
  }
  if (minFreq) {
    const minFreqIdx = hzToMidi(minFreq) - MIDI_OFFSET;
    for (let i = 0; i < onsets.length; i++) {
      onsets[i].fill(0, 0, minFreqIdx);
    }
    for (let i = 0; i < frames.length; i++) {
      frames[i].fill(0, 0, minFreqIdx);
    }
  }
}

function getInferredOnsets(onsets, frames, nDiff = 2) {
  const diffs = [];
  for (let n = 1; n <= nDiff; n++) {
    const zeroRows = Array(n).fill(null).map(() => Array(frames[0].length).fill(0));
    const framesAppended = zeroRows.concat(frames);
    const nPlus = framesAppended.slice(n);
    const minusN = framesAppended.slice(0, -n);
    const diff = nPlus.map((row, r) => row.map((v, c) => v - minusN[r][c]));
    diffs.push(diff);
  }
  let frameDiff = min3dForAxis0(diffs);
  frameDiff = frameDiff.map(row => row.map(v => Math.max(v, 0)));
  frameDiff = frameDiff.map((row, r) => (r < nDiff ? row.fill(0) : row));
  const onsetMax = globalMax(onsets);
  const frameDiffMax = globalMax(frameDiff);
  frameDiff = frameDiff.map(row => row.map(v => (onsetMax * v) / frameDiffMax));
  return max3dForAxis0([onsets, frameDiff]);
}

function outputToNotesPoly(
  frames,
  onsets,
  onsetThresh = 0.5,
  frameThresh = 0.3,
  minNoteLen = 5,
  inferOnsets = true,
  maxFreq = null,
  minFreq = null,
  melodiaTrick = true,
  energyTolerance = 11,
) {
  let inferredFrameThresh = frameThresh;
  if (inferredFrameThresh === null) {
    const [mean, std] = meanStdDev(frames);
    inferredFrameThresh = mean + std;
  }
  const nFrames = frames.length;
  constrainFrequency(onsets, frames, maxFreq, minFreq);
  let inferredOnsets = onsets;
  if (inferOnsets) {
    inferredOnsets = getInferredOnsets(onsets, frames);
  }
  const peakThresholdMatrix = inferredOnsets.map(o => o.map(() => 0));
  argRelMax(inferredOnsets).forEach(([row, col]) => {
    peakThresholdMatrix[row][col] = inferredOnsets[row][col];
  });
  const [noteStarts, freqIdxs] = whereGreaterThanAxis1(peakThresholdMatrix, onsetThresh);
  noteStarts.reverse();
  freqIdxs.reverse();
  const remainingEnergy = frames.map(frame => frame.slice());
  const noteEvents = [];
  for (let idx = 0; idx < noteStarts.length; idx++) {
    const noteStartIdx = noteStarts[idx];
    const freqIdx = freqIdxs[idx];
    if (noteStartIdx >= nFrames - 1) continue;
    let i = noteStartIdx + 1;
    let k = 0;
    while (i < nFrames - 1 && k < energyTolerance) {
      if (remainingEnergy[i][freqIdx] < inferredFrameThresh) {
        k += 1;
      } else {
        k = 0;
      }
      i += 1;
    }
    i -= k;
    if (i - noteStartIdx <= minNoteLen) continue;
    for (let j = noteStartIdx; j < i; ++j) {
      remainingEnergy[j][freqIdx] = 0;
      if (freqIdx < MAX_FREQ_IDX) remainingEnergy[j][freqIdx + 1] = 0;
      if (freqIdx > 0) remainingEnergy[j][freqIdx - 1] = 0;
    }
    let frameSum = 0;
    for (let j = noteStartIdx; j < i; j++) {
      frameSum += frames[j][freqIdx];
    }
    const amplitude = frameSum / (i - noteStartIdx);
    noteEvents.push({
      startFrame: noteStartIdx,
      durationFrames: i - noteStartIdx,
      pitchMidi: freqIdx + MIDI_OFFSET,
      amplitude: amplitude,
    });
  }
  if (melodiaTrick === true && nFrames > 0 && remainingEnergy[0].length > 0) {
    // B5: Flatten remainingEnergy to 1D Float32Array + per-column max tracking.
    // (see basicPitch.js history for the optimization rationale; logic unchanged)
    const numCols = remainingEnergy[0].length;
    const flatEnergy = new Float32Array(nFrames * numCols);
    const colMaxRow = new Int32Array(numCols);
    const colMaxValue = new Float32Array(numCols);
    for (let c = 0; c < numCols; c++) {
      colMaxValue[c] = -1;
      colMaxRow[c] = 0;
    }
    for (let r = 0; r < nFrames; r++) {
      const rowOffset = r * numCols;
      const row = remainingEnergy[r];
      for (let c = 0; c < numCols; c++) {
        const v = row[c];
        flatEnergy[rowOffset + c] = v;
        if (v > colMaxValue[c]) {
          colMaxValue[c] = v;
          colMaxRow[c] = r;
        }
      }
    }

    while (true) {
      let maxVal = -1;
      let iMid = 0;
      let freqIdx = 0;
      for (let c = 0; c < numCols; c++) {
        if (colMaxValue[c] > maxVal) {
          maxVal = colMaxValue[c];
          iMid = colMaxRow[c];
          freqIdx = c;
        }
      }
      if (maxVal <= inferredFrameThresh) break;

      flatEnergy[iMid * numCols + freqIdx] = 0;
      let i = iMid + 1;
      let k = 0;
      while (i < nFrames - 1 && k < energyTolerance) {
        if (flatEnergy[i * numCols + freqIdx] < inferredFrameThresh) {
          k += 1;
        } else {
          k = 0;
        }
        flatEnergy[i * numCols + freqIdx] = 0;
        if (freqIdx < MAX_FREQ_IDX) flatEnergy[i * numCols + freqIdx + 1] = 0;
        if (freqIdx > 0) flatEnergy[i * numCols + freqIdx - 1] = 0;
        i += 1;
      }
      const iEnd = i - 1 - k;
      const fwdZeroEnd = i - 1;
      i = iMid - 1;
      k = 0;
      while (i > 0 && k < energyTolerance) {
        if (flatEnergy[i * numCols + freqIdx] < inferredFrameThresh) {
          k += 1;
        } else {
          k = 0;
        }
        flatEnergy[i * numCols + freqIdx] = 0;
        if (freqIdx < MAX_FREQ_IDX) flatEnergy[i * numCols + freqIdx + 1] = 0;
        if (freqIdx > 0) flatEnergy[i * numCols + freqIdx - 1] = 0;
        i -= 1;
      }
      const iStart = i + 1 + k;
      const bwdZeroStart = i + 1;

      const zeroStart = Math.min(iMid, bwdZeroStart);
      const zeroEnd = Math.max(iMid, fwdZeroEnd);
      for (let dc = -1; dc <= 1; dc++) {
        const c = freqIdx + dc;
        if (c < 0 || c >= numCols) continue;
        if (colMaxRow[c] >= zeroStart && colMaxRow[c] <= zeroEnd) {
          let newMax = -1;
          let newRow = 0;
          for (let r = 0; r < nFrames; r++) {
            const v = flatEnergy[r * numCols + c];
            if (v > newMax) {
              newMax = v;
              newRow = r;
            }
          }
          colMaxValue[c] = newMax;
          colMaxRow[c] = newRow;
        }
      }

      if (iStart < 0 || iEnd >= nFrames) continue;
      let frameSum = 0;
      for (let j = iStart; j < iEnd; j++) {
        frameSum += frames[j][freqIdx];
      }
      const amplitude = frameSum / (iEnd - iStart);
      if (iEnd - iStart <= minNoteLen) continue;
      noteEvents.push({
        startFrame: iStart,
        durationFrames: iEnd - iStart,
        pitchMidi: freqIdx + MIDI_OFFSET,
        amplitude: amplitude,
      });
    }
  }
  return noteEvents;
}

/**
 * Convert flat model output to 2D rows (Float32Array views).
 * Same as tensorTo2DRows but takes the flat array directly so non-TF.js
 * backends (LiteRT) can use it.
 */
function flatTo2DRows(flatData, numCols) {
  const numRows = Math.floor(flatData.length / numCols);
  const rows = new Array(numRows);
  for (let r = 0; r < numRows; r++) {
    rows[r] = flatData.subarray(r * numCols, (r + 1) * numCols);
  }
  return rows;
}

const ANNOT_N_FRAMES = ANNOTATIONS_FPS * AUDIO_WINDOW_LENGTH_SECONDS;
const WINDOW_OFFSET =
  (FFT_HOP / BASIC_PITCH_SAMPLE_RATE) * (ANNOT_N_FRAMES - AUDIO_N_SAMPLES / FFT_HOP) +
  0.0018;

function modelFrameToTime(frame) {
  return (frame * FFT_HOP) / BASIC_PITCH_SAMPLE_RATE -
    WINDOW_OFFSET * Math.floor(frame / ANNOT_N_FRAMES);
}

function noteFramesToTime(notes) {
  return notes.map(note => ({
    pitchMidi: note.pitchMidi,
    amplitude: note.amplitude,
    pitchBends: note.pitchBends,
    startTimeSeconds: modelFrameToTime(note.startFrame),
    durationSeconds:
      modelFrameToTime(note.startFrame + note.durationFrames) -
      modelFrameToTime(note.startFrame),
  }));
}

function midiPitchToContourBin(pitchMidi) {
  return 12.0 * CONTOUR_BINS_PER_SEMITONE *
    Math.log2(midiToHz(pitchMidi) / 27.5);
}

function addPitchBendsToNoteEvents(contours, notes, nBinsTolerance = 25) {
  const windowLength = nBinsTolerance * 2 + 1;
  const freqGaussian = gaussian(windowLength, 5);
  return notes.map(note => {
    const freqIdx = Math.floor(Math.round(midiPitchToContourBin(note.pitchMidi)));
    const freqStartIdx = Math.max(freqIdx - nBinsTolerance, 0);
    const freqEndIdx = Math.min(N_FREQ_BINS_CONTOURS, freqIdx + nBinsTolerance + 1);
    const freqGuassianSubMatrix = freqGaussian.slice(
      Math.max(0, nBinsTolerance - freqIdx),
      windowLength - Math.max(0, freqIdx - (N_FREQ_BINS_CONTOURS - nBinsTolerance - 1)),
    );
    const pitchBendSubmatrix = contours
      .slice(note.startFrame, note.startFrame + note.durationFrames)
      .map(d =>
        d
          .slice(freqStartIdx, freqEndIdx)
          .map((v, col) => v * freqGuassianSubMatrix[col]),
      );
    const pbShift = nBinsTolerance - Math.max(0, nBinsTolerance - freqIdx);
    const bends = argMaxAxis1(pitchBendSubmatrix).map(v => v - pbShift);
    return {
      ...note,
      pitchBends: bends,
    };
  });
}

/** notes（time 域）→ f0 序列（与 BasicPitchDetector.notesToF0Array 一致） */
function notesToF0Array(notes) {
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

/** notes（time 域）→ 编辑器音符（与 BasicPitchDetector.notesToMidiNotes 一致） */
function notesToMidiNotes(notes, bpm) {
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

/**
 * 完整后处理管线：模型三组输出 → { f0Array, notes }。
 * @param {Array<Float32Array>} frames - [F][88] note 激活
 * @param {Array<Float32Array>} onsets - [F][88] onset 激活
 * @param {Array<Float32Array>} contours - [F][264] contour 激活
 * @param {number} bpm
 */
function postprocessModelOutputs(frames, onsets, contours, bpm) {
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
  return {
    f0Array: notesToF0Array(adjustedNotes),
    notes: notesToMidiNotes(adjustedNotes, bpm),
  };
}

module.exports = {
  BASIC_PITCH_SAMPLE_RATE,
  CONTOUR_BINS_PER_SEMITONE,
  ANNOTATIONS_FPS,
  AUDIO_WINDOW_LENGTH_SECONDS,
  FFT_HOP,
  AUDIO_N_SAMPLES,
  N_OVERLAPPING_FRAMES,
  N_OVERLAP_OVER_2,
  OVERLAP_LENGTH_FRAMES,
  HOP_SIZE,
  N_FREQ_BINS_CONTOURS,
  gaussian,
  argMax,
  argMaxAxis1,
  whereGreaterThanAxis1,
  meanStdDev,
  globalMax,
  midiToHz,
  hzToMidi,
  outputToNotesPoly,
  noteFramesToTime,
  addPitchBendsToNoteEvents,
  flatTo2DRows,
  notesToF0Array,
  notesToMidiNotes,
  postprocessModelOutputs,
};
