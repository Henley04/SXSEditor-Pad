import { state, dom, trackManager, history } from './state.js';
import {
  SINGER_ROW_HEIGHT,
  HEADER_HEIGHT,
} from './constants.js';
import { t } from '../i18n/index.js';
import { updateProjectSettings, saveProject, saveProjectAs, loadProject, showSingerSelectDialog, markDirty } from './projectManager.js';
import { playAll, pausePlayback, stopPlayback, exportAll, getCurrentPlaybackSeconds, startAudioPlayback } from './audioPlayback.js';
import { formatTime } from './uiControls.js';
import { getBeatWidth, renderFragmentTimeline, syncFragmentScroll, refreshAll, playbackTimeToX, xToPlaybackTime, PLAYHEAD_HIT_WIDTH, drawPausedPlayheadAt } from './timelineRenderer.js';
import { openFragmentEditor, finishDrag, handleAudioToMidi, handleImportMidi } from './fragmentOperations.js';
import { showConfirmDialog } from '../alertDialog.js';

// Click-vs-drag tracking for fragment selection
let _clickStartPos = null;
const CLICK_THRESHOLD = 3;

// Playhead drag state — 拖拽进度条时记录是否在拖拽 playhead
let _isPlayheadDragging = false;
// 拖拽开始时是否正在播放。mouseup 时若为 true，则从新位置恢复播放。
// 拖拽期间只更新视觉（不重启 source），避免每次 mousemove 重启播放导致卡顿。
let _wasPlayingBeforeDrag = false;
// Playhead tooltip 元素（懒创建）
let _playheadTooltip = null;
// rAF 节流：mousemove 触发频率高于刷新率，合并同一帧内的多次 playhead 视觉更新。
// _playheadDragRaf 标记是否有 pending 的 rAF 回调；
// _playheadDragPendingSeconds 记录最新一次 mousemove 计算出的秒数，供 rAF 回调读取。
let _playheadDragRaf = 0;
let _playheadDragPendingSeconds = 0;

function _ensurePlayheadTooltip() {
  if (_playheadTooltip && document.body.contains(_playheadTooltip)) return _playheadTooltip;
  _playheadTooltip = document.createElement('div');
  _playheadTooltip.className = 'playhead-tooltip';
  _playheadTooltip.style.cssText = `
    position: fixed;
    z-index: 9999;
    padding: 4px 8px;
    background: var(--bg-tooltip, #1a1a2e);
    color: var(--fg-tooltip, #e0e0f0);
    border: 1px solid var(--border-tooltip, #3a3a5a);
    border-radius: 3px;
    font-size: 11px;
    font-family: sans-serif;
    pointer-events: none;
    white-space: nowrap;
    box-shadow: 0 2px 6px rgba(0,0,0,0.4);
    display: none;
  `;
  document.body.appendChild(_playheadTooltip);
  return _playheadTooltip;
}

function _showPlayheadTooltip(clientX, clientY, seconds) {
  const tip = _ensurePlayheadTooltip();
  tip.textContent = formatTime(seconds) + ' · ' + t('main.dragToSeek');
  tip.style.left = (clientX + 12) + 'px';
  tip.style.top = (clientY + 12) + 'px';
  tip.style.display = 'block';
}

function _hidePlayheadTooltip() {
  if (_playheadTooltip) _playheadTooltip.style.display = 'none';
}

/**
 * 计算当前播放头在 fragment canvas 内部坐标系下的 X。
 * 播放中：实时计算；未播放：使用 playbackPauseOffset。
 */
function _getCurrentPlayheadX() {
  return playbackTimeToX(getCurrentPlaybackSeconds());
}

/**
 * 把鼠标事件的 clientX 转换为 fragment canvas 内部 X 坐标。
 * 因为 fragment-canvas 自身有 translate(-scrollX, -scrollY) 变换，
 * getBoundingClientRect() 已反映了变换后的位置，所以 clientX-rect.left
 * 直接就是 canvas 内部坐标。
 */
function _mouseToCanvasX(e) {
  const rect = dom.fragmentCanvas.getBoundingClientRect();
  return e.clientX - rect.left;
}

function _mouseToCanvasY(e) {
  const rect = dom.fragmentCanvas.getBoundingClientRect();
  return e.clientY - rect.top;
}

/**
 * 把 canvas 内部 X 坐标转换为可播放的秒数，并截断到 [0, duration - 0.05]。
 * 余量 50ms 防止拖拽到接近末尾时 source.start(0, offset) 几乎立即结束触发 onended
 * 重置位置到 0，导致 playhead 从拖拽位置跳回开头。
 */
function _canvasXToClampedSeconds(x) {
  const seconds = xToPlaybackTime(x);
  const audioData = state.currentAudioData;
  if (!audioData || audioData.length === 0) {
    return Math.max(0, seconds);
  }
  const duration = audioData.length / 24000; // SAMPLE_RATE
  // 短音频 fallback：若音频本身不足 100ms，余量缩减到 duration / 2
  const margin = duration > 0.1 ? 0.05 : duration * 0.5;
  return Math.max(0, Math.min(duration - margin, seconds));
}

/**
 * 拖拽期间只更新视觉（不重启 source）。
 * 更新 state.playbackPauseOffset（作为 mouseup 后恢复播放的起点）、
 * 绘制暂停态 playhead、更新时间显示。
 * playhead 绘制走 rAF 节流：mousemove 频率高于刷新率，合并同一帧内的多次更新，
 * 避免分片变长后大 canvas 重复 clearRect/drawImage 造成掉帧。
 */
function _updatePlayheadVisual(seconds) {
  state.playbackPauseOffset = seconds;
  dom.timeDisplay.textContent = formatTime(seconds);
  _playheadDragPendingSeconds = seconds;
  if (!_playheadDragRaf) {
    _playheadDragRaf = requestAnimationFrame(() => {
      _playheadDragRaf = 0;
      drawPausedPlayheadAt(_playheadDragPendingSeconds);
    });
  }
}

/**
 * rAF 节流重绘：时间轴改为「只绘制可视区」后，滚动/平移必须重绘才能把新进入
 * 视野的区域画出来。pointermove 频率高于刷新率，这里合并同一帧内的多次请求。
 */
function _scheduleTimelineRender() {
  if (state.renderPending) return;
  state.renderPending = true;
  requestAnimationFrame(() => {
    state.renderPending = false;
    renderFragmentTimeline();
  });
}

/**
 * 结束拖拽：若拖拽前正在播放，从当前位置恢复播放。
 * 取消 pending rAF 并立即绘制最终位置，确保 mouseup 后 playhead 视觉与播放起点一致。
 */
function _endPlayheadDrag() {
  if (!_isPlayheadDragging) return;
  _isPlayheadDragging = false;
  _hidePlayheadTooltip();
  if (_playheadDragRaf) {
    cancelAnimationFrame(_playheadDragRaf);
    _playheadDragRaf = 0;
  }
  drawPausedPlayheadAt(state.playbackPauseOffset);
  if (_wasPlayingBeforeDrag) {
    _wasPlayingBeforeDrag = false;
    startAudioPlayback(state.playbackPauseOffset);
  }
}

// BPM and time signature inputs
dom.bpmInput.addEventListener('change', () => {
  updateProjectSettings();
  refreshAll();
});
dom.timeSigNum.addEventListener('change', () => {
  updateProjectSettings();
  refreshAll();
});
dom.timeSigDen.addEventListener('change', () => {
  updateProjectSettings();
  refreshAll();
});

// Transport controls
dom.btnPlay.addEventListener('click', async () => {
  const fragments = trackManager.getFragments();
  if (fragments.length === 0) {
    const { showAlertDialog } = await import('../alertDialog.js');
    showAlertDialog(t('main.noFragmentsToPlay'));
    return;
  }
  if (state.isPlaying || state.isSynthesizing) {
    return;
  }
  // 已有缓存的合成音频：从暂停位置恢复播放（无需重新合成）。
  // stopPlayback / 自然结束时 currentAudioData 会被置 null，下次点击 Play 会重新合成。
  if (state.currentAudioData && state.currentAudioData.length > 0) {
    await startAudioPlayback(state.playbackPauseOffset);
  } else {
    await playAll();
  }
});

dom.btnPause.addEventListener('click', () => {
  if (state.isPlaying) {
    pausePlayback();
  }
});

dom.btnStop.addEventListener('click', () => {
  stopPlayback();
  dom.timeDisplay.textContent = formatTime(0);
});

// Project save/load/export
// Save is triggered via menu (File → Save, Ctrl+S) or the menu-request IPC.
dom.btnLoad.addEventListener('click', async () => {
  await loadProject();
  refreshAll();
});

dom.btnExport.addEventListener('click', async () => {
  await exportAll();
});

// Add singer
dom.btnAddSinger.addEventListener('click', () => {
  showSingerSelectDialog(null);
});

// Open the Singer Market window (browse / upload / download community singers)
dom.btnOpenSingerMarket.addEventListener('click', () => {
  if (window.electronAPI?.openSingerMarket) {
    window.electronAPI.openSingerMarket();
  }
});

// Audio to MIDI
dom.btnAudioToMidi.addEventListener('click', handleAudioToMidi);

// Import MIDI file (multi-track → one singer per track)
dom.btnImportMidi.addEventListener('click', handleImportMidi);

// ==================== Fragment canvas pointer / touch interaction ====================
// 审计修复：原先只监听 mousedown / mousemove / mouseup，在 Pad（触屏）上完全
// 依赖浏览器合成的兼容鼠标事件，导致：
//   * 分片拖拽、播放头拖动在 WebView 上经常失灵（无 hover 语义、move 序列被打断）；
//   * 时间轴只能靠 wheel 滚动/缩放 —— 触屏根本没有 wheel，横向滚动与缩放不可及；
//   * 右键上下文菜单（删除分片）在触屏上无法触发。
// 现在改为 Pointer Events（鼠标 / 触摸 / 触控笔统一）+ 双指手势 + 长按菜单 +
// 单指空白区拖拽平移，桌面鼠标行为保持完全不变。

const PAN_THRESHOLD = 8;    // 空白区拖拽进入"平移视图"的位移阈值(px)
const LONG_PRESS_MS = 500;  // 触摸长按 → 弹出上下文菜单
const DOUBLE_TAP_MS = 320;  // 触摸双击 → 打开分片编辑器
const DOUBLE_TAP_SLOP = 24; // 双击两次落点的最大偏移(px)

// 单指/鼠标交互状态
let _activePointerId = null;
let _panStart = null;        // { clientX, clientY, scrollX, scrollY }
let _isPanning = false;
let _longPressTimer = 0;
let _longPressFired = false;
let _lastTapTime = 0;
let _lastTapPos = null;
let _touchGestureActive = false;  // 双指手势进行中 → 暂停单指交互
let _suppressDblclickUntil = 0;   // 触摸双击已处理时抑制随后的合成 dblclick

function _canvasCoords(e) {
  const rect = dom.fragmentCanvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function _isOnPlayhead(x) {
  const playheadX = _getCurrentPlayheadX();
  return Math.abs(x - playheadX) <= PLAYHEAD_HIT_WIDTH / 2
    && !!(state.playbackPauseOffset > 0 || state.isPlaying || state.currentAudioData);
}

/**
 * 分片命中测试：返回可直接写入 state.dragState 的描述对象，未命中返回 null。
 * 判定顺序：左边缘(resize-left) → 右边缘(resize-right) → 主体(move)。
 */
function _hitTestFragment(x, y) {
  const singers = trackManager.getSingers();
  const fragments = trackManager.getFragments();
  const beatWidth = getBeatWidth();

  for (let i = 0; i < singers.length; i++) {
    const singerY = i * SINGER_ROW_HEIGHT + HEADER_HEIGHT;
    if (y < singerY || y >= singerY + SINGER_ROW_HEIGHT) continue;

    const singerId = singers[i].id;
    const singerFragments = fragments.filter(f => f.singerId === singerId);

    for (const fragment of singerFragments) {
      const fragX = fragment.startTime * beatWidth;
      const fragWidth = fragment.duration * beatWidth;

      if (x >= fragX - 4 && x <= fragX + 4) {
        return { type: 'resize-left', fragment, startX: x, originalStart: fragment.startTime, originalDuration: fragment.duration };
      }
      if (x >= fragX + fragWidth - 4 && x <= fragX + fragWidth + 4) {
        return { type: 'resize-right', fragment, startX: x, originalStart: fragment.startTime, originalDuration: fragment.duration };
      }
      if (x >= fragX && x <= fragX + fragWidth) {
        return { type: 'move', fragment, startX: x, startY: y, originalStart: fragment.startTime, originalSingerId: fragment.singerId };
      }
    }
  }
  return null;
}

function _beginFragmentDrag(hit) {
  state.dragState = hit;
  const f = hit.fragment;
  state.fragmentDragSnapshot = hit.type === 'move'
    ? { startTime: f.startTime, duration: f.duration, singerId: f.singerId }
    : { startTime: f.startTime, duration: f.duration };
}

function _cancelLongPress() {
  if (_longPressTimer) {
    clearTimeout(_longPressTimer);
    _longPressTimer = 0;
  }
}

/**
 * 触摸长按 → 上下文菜单（替代触屏上不可用的右键菜单）。
 */
function _scheduleLongPress(clientX, clientY, fragment) {
  _cancelLongPress();
  _longPressTimer = setTimeout(() => {
    _longPressTimer = 0;
    _longPressFired = true;
    // 取消进行中的拖拽 / 平移，避免菜单弹出后手指抬起仍改动分片
    state.dragState = null;
    state.fragmentDragSnapshot = null;
    _isPanning = false;
    _panStart = null;
    state.selectedFragmentId = fragment.id;
    renderFragmentTimeline();
    showFragmentContextMenu(clientX, clientY, fragment);
  }, LONG_PRESS_MS);
}

function _resetPointerInteraction() {
  _activePointerId = null;
  _panStart = null;
  _isPanning = false;
  _clickStartPos = null;
}

function onPointerDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (_touchGestureActive) return;   // 双指手势接管时忽略单指事件

  const { x, y } = _canvasCoords(e);
  _clickStartPos = { x: e.clientX, y: e.clientY };
  _activePointerId = e.pointerId;
  _isPanning = false;
  _longPressFired = false;
  _panStart = null;
  try { dom.fragmentCanvas.setPointerCapture(e.pointerId); } catch (_) { /* 不支持时忽略 */ }

  // 1) 播放头手柄 / 顶部时间标尺 → 拖拽定位
  if (_isOnPlayhead(x) || y <= HEADER_HEIGHT) {
    const newSeconds = _canvasXToClampedSeconds(x);
    if (state.isPlaying) {
      _wasPlayingBeforeDrag = true;
      pausePlayback();
    } else {
      _wasPlayingBeforeDrag = false;
    }
    _isPlayheadDragging = true;
    _updatePlayheadVisual(newSeconds);
    _hidePlayheadTooltip();
    return;
  }

  // 2) 分片 / 边缘
  const hit = _hitTestFragment(x, y);
  if (hit) {
    _beginFragmentDrag(hit);
    if (e.pointerType !== 'mouse') {
      _scheduleLongPress(e.clientX, e.clientY, hit.fragment);
    }
    return;
  }

  // 3) 空白区：预备平移（触屏可拖时间轴，鼠标按住拖同样可用）
  _panStart = {
    clientX: e.clientX,
    clientY: e.clientY,
    scrollX: state.fragmentScrollX,
    scrollY: state.fragmentScrollY,
  };
}

function onPointerMove(e) {
  if (_activePointerId !== null && e.pointerId !== _activePointerId) return;
  const { x, y } = _canvasCoords(e);

  // 播放头拖拽优先级最高：只更新视觉（不重启 source，避免卡顿）
  if (_isPlayheadDragging) {
    const seconds = _canvasXToClampedSeconds(x);
    _updatePlayheadVisual(seconds);
    return;
  }

  if (!state.dragState) {
    // 空白区拖拽 → 平移视图（触屏上唯一能滚动时间轴的方式之一）
    if (_panStart) {
      const dx = e.clientX - _panStart.clientX;
      const dy = e.clientY - _panStart.clientY;
      if (!_isPanning && Math.abs(dx) + Math.abs(dy) > PAN_THRESHOLD) {
        _isPanning = true;
        _cancelLongPress();
      }
      if (_isPanning) {
        state.fragmentScrollX = _panStart.scrollX - dx;
        state.fragmentScrollY = _panStart.scrollY - dy;
        _scheduleTimelineRender();
        _hidePlayheadTooltip();
        return;
      }
    }

    // 悬停反馈仅对鼠标/触控笔有意义（触屏无 hover）
    if (e.pointerType === 'mouse') {
      if (_isOnPlayhead(x) || y <= HEADER_HEIGHT) {
        dom.fragmentCanvas.style.cursor = 'ew-resize';
        const tipSeconds = _canvasXToClampedSeconds(x);
        _showPlayheadTooltip(e.clientX, e.clientY, tipSeconds);
      } else {
        dom.fragmentCanvas.style.cursor = 'default';
        _hidePlayheadTooltip();
      }
    }
    return;
  }

  // 手指/鼠标移动超过阈值 → 判定为拖拽，取消长按菜单
  if (_clickStartPos && _longPressTimer) {
    if (Math.abs(e.clientX - _clickStartPos.x) + Math.abs(e.clientY - _clickStartPos.y) > PAN_THRESHOLD) {
      _cancelLongPress();
    }
  }

  const beatWidth = getBeatWidth();
  const dx = (x - state.dragState.startX) / beatWidth;

  if (state.dragState.type === 'move') {
    const newStart = Math.max(0, state.dragState.originalStart + dx);
    const updateData = { startTime: Math.round(newStart * 4) / 4 };

    // 拖到其它歌手轨道行 → 换轨
    const singers = trackManager.getSingers();
    for (let i = 0; i < singers.length; i++) {
      const singerY = i * SINGER_ROW_HEIGHT + HEADER_HEIGHT;
      if (y >= singerY && y < singerY + SINGER_ROW_HEIGHT) {
        const targetSingerId = singers[i].id;
        if (targetSingerId !== state.dragState.fragment.singerId) {
          updateData.singerId = targetSingerId;
          updateData.color = singers[i].color;
        }
        break;
      }
    }

    trackManager.updateFragment(state.dragState.fragment.id, updateData);
  } else if (state.dragState.type === 'resize-right') {
    const newDuration = Math.max(0.25, state.dragState.originalDuration + dx);
    trackManager.updateFragment(state.dragState.fragment.id, { duration: Math.round(newDuration * 4) / 4 });
  } else if (state.dragState.type === 'resize-left') {
    const originalEnd = state.dragState.originalStart + state.dragState.originalDuration;
    const newStart = state.dragState.originalStart + dx;
    const alignedStart = Math.max(0, Math.round(newStart * 4) / 4);
    const newDuration = originalEnd - alignedStart;
    if (alignedStart >= 0 && newDuration >= 0.25) {
      trackManager.updateFragment(state.dragState.fragment.id, {
        startTime: alignedStart,
        duration: newDuration,
      });
    }
  }

  if (!state.renderPending) {
    state.renderPending = true;
    requestAnimationFrame(() => {
      renderFragmentTimeline();
      if (window.electronAPI?.updateFragmentBounds && state.dragState) {
        const frag = state.dragState.fragment;
        window.electronAPI.updateFragmentBounds(frag.id, {
          startTime: frag.startTime,
          duration: frag.duration,
        });
      }
      state.renderPending = false;
    });
  }
}

function onPointerUp(e) {
  if (_activePointerId !== null && e.pointerId !== _activePointerId) return;
  _cancelLongPress();
  try {
    if (e.pointerId != null && dom.fragmentCanvas.hasPointerCapture?.(e.pointerId)) {
      dom.fragmentCanvas.releasePointerCapture(e.pointerId);
    }
  } catch (_) { /* noop */ }

  const wasPanning = _isPanning;
  const wasLongPress = _longPressFired;
  const clickStart = _clickStartPos;
  _resetPointerInteraction();

  if (_isPlayheadDragging) {
    _endPlayheadDrag();
    return;
  }
  // 平移 / 长按菜单已消费本次手势，不再做选中或落历史
  if (wasPanning || wasLongPress) return;

  if (clickStart) {
    const dx = e.clientX - clickStart.x;
    const dy = e.clientY - clickStart.y;
    const isClick = Math.abs(dx) < CLICK_THRESHOLD && Math.abs(dy) < CLICK_THRESHOLD;
    const { x, y } = _canvasCoords(e);

    if (isClick && y > HEADER_HEIGHT) {
      const hit = _hitTestFragment(x, y);
      if (hit) {
        state.selectedFragmentId = hit.fragment.id;
        renderFragmentTimeline();

        // 触摸双击 → 打开分片编辑器（鼠标走原生 dblclick）
        if (e.pointerType !== 'mouse') {
          const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          if (_lastTapPos && now - _lastTapTime < DOUBLE_TAP_MS
              && Math.hypot(e.clientX - _lastTapPos.x, e.clientY - _lastTapPos.y) < DOUBLE_TAP_SLOP) {
            _lastTapTime = 0;
            _lastTapPos = null;
            // 抑制 WebView 在双击后补发的合成 dblclick，避免打开两个窗口
            _suppressDblclickUntil = now + 600;
            openFragmentEditor(hit.fragment);
            return;
          }
          _lastTapTime = now;
          _lastTapPos = { x: e.clientX, y: e.clientY };
        }
        return;
      }
      // 空白点击 → 取消选择
      state.selectedFragmentId = null;
      renderFragmentTimeline();
      return;
    }
  }

  finishDrag();
}

function onPointerCancel() {
  _cancelLongPress();
  _resetPointerInteraction();
  if (_isPlayheadDragging) _endPlayheadDrag();
  finishDrag();
}

dom.fragmentCanvas.addEventListener('pointerdown', onPointerDown);
dom.fragmentCanvas.addEventListener('pointermove', onPointerMove);
dom.fragmentCanvas.addEventListener('pointerup', onPointerUp);
dom.fragmentCanvas.addEventListener('pointercancel', onPointerCancel);
dom.fragmentCanvas.addEventListener('pointerleave', (e) => {
  if (e.pointerType !== 'mouse') return;   // 触屏抬手会派发 leave，交给 pointerup
  _resetPointerInteraction();
  _endPlayheadDrag();
  finishDrag();
});

// ==================== Two-finger pan / pinch zoom (touch) ====================
// canvas 上 `touch-action: none`，浏览器不会代管手势；这里把双指手势翻译成
// 横向/纵向滚动与 X 轴缩放，等价于桌面上的 wheel / ctrl+wheel。
const _gestureTarget = dom.fragmentContainer || dom.fragmentCanvas;
let _twoFinger = null;
let _touchRaf = 0;
let _pendingTouchEvent = null;

function _resetTouchGesture() {
  _touchGestureActive = false;
  _twoFinger = null;
  _pendingTouchEvent = null;
  if (_touchRaf) {
    cancelAnimationFrame(_touchRaf);
    _touchRaf = 0;
  }
}

function _applyTwoFingerGesture() {
  _touchRaf = 0;
  const ev = _pendingTouchEvent;
  _pendingTouchEvent = null;
  if (!ev || !_twoFinger || ev.touches.length !== 2) return;

  const t1 = ev.touches[0];
  const t2 = ev.touches[1];
  const newDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
  const midX = (t1.clientX + t2.clientX) / 2;
  const midY = (t1.clientY + t2.clientY) / 2;
  const g = _twoFinger;

  // --- 捏合缩放（相对上一帧增量更新基准，避免持续放大/缩小漂移）---
  const zoomRatio = g.dist > 0 ? newDist / g.dist : 1;
  if (Math.abs(zoomRatio - 1) > 0.01) {
    const containerRect = dom.fragmentContainer.getBoundingClientRect();
    const anchorX = g.midX - containerRect.left;
    const oldBeatWidth = getBeatWidth();
    const anchorBeats = (anchorX + state.fragmentScrollX) / oldBeatWidth;
    const nextZoom = Math.max(0.25, Math.min(4, g.zoomX * zoomRatio));
    state.fragmentZoomX = nextZoom;
    const newBeatWidth = getBeatWidth();
    state.fragmentScrollX = anchorBeats * newBeatWidth - anchorX;
    syncFragmentScroll();
    renderFragmentTimeline();
    g.zoomX = nextZoom;
    g.dist = newDist;
  }

  // --- 双指平移 ---
  const dx = midX - g.midX;
  const dy = midY - g.midY;
  if (dx !== 0 || dy !== 0) {
    state.fragmentScrollX = g.scrollX - dx;
    state.fragmentScrollY = g.scrollY - dy;
    // 时间轴按可视区绘制，滚动后必须重绘（已在 rAF 内，直接同步绘制）
    renderFragmentTimeline();
  }
  // 增量推进基准，支持"缩放+平移"混合手势
  g.midX = midX;
  g.midY = midY;
  g.scrollX = state.fragmentScrollX;
  g.scrollY = state.fragmentScrollY;
}

_gestureTarget.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 2) return;
  _touchGestureActive = true;
  // 取消单指进行中的操作，避免与双指手势打架
  _cancelLongPress();
  if (_isPlayheadDragging) _endPlayheadDrag();
  state.dragState = null;
  state.fragmentDragSnapshot = null;
  _isPanning = false;
  _panStart = null;

  const t1 = e.touches[0];
  const t2 = e.touches[1];
  _twoFinger = {
    dist: Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY),
    midX: (t1.clientX + t2.clientX) / 2,
    midY: (t1.clientY + t2.clientY) / 2,
    scrollX: state.fragmentScrollX,
    scrollY: state.fragmentScrollY,
    zoomX: state.fragmentZoomX,
  };
}, { passive: false });

_gestureTarget.addEventListener('touchmove', (e) => {
  if (e.touches.length !== 2 || !_twoFinger) return;
  e.preventDefault();
  _pendingTouchEvent = e;
  if (_touchRaf) return;
  _touchRaf = requestAnimationFrame(_applyTwoFingerGesture);
}, { passive: false });

_gestureTarget.addEventListener('touchend', (e) => {
  if (e.touches.length < 2) _resetTouchGesture();
}, { passive: false });

// 系统手势打断（来电/下拉通知等）时必须复位，否则 _touchGestureActive 常驻
// 会让后续所有单指交互失效。
_gestureTarget.addEventListener('touchcancel', () => {
  _resetTouchGesture();
}, { passive: false });

dom.fragmentCanvas.addEventListener('dblclick', (e) => {
  // 触摸双击已在 pointerup 里处理并打开编辑器；这里忽略随后补发的合成
  // dblclick，否则同一次双击会打开两个分片编辑窗口。
  const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  if (now < _suppressDblclickUntil) return;

  const { x, y } = _canvasCoords(e);
  const hit = _hitTestFragment(x, y);
  if (hit) openFragmentEditor(hit.fragment);
});

dom.fragmentCanvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const { x, y } = _canvasCoords(e);
  const hit = _hitTestFragment(x, y);
  if (!hit) return;
  // Select the fragment first
  state.selectedFragmentId = hit.fragment.id;
  renderFragmentTimeline();
  // Show context menu（触屏走 pointerdown 的长按分支）
  showFragmentContextMenu(e.clientX, e.clientY, hit.fragment);
});

// Wheel events: rAF-coalesced to avoid layout thrash on high-frequency trackpad scroll.
// The latest wheel event is captured and processed inside a single rAF callback;
// subsequent events before the frame fires just overwrite the pending state.
let _wheelRaf = 0;
let _pendingWheelEvent = null;
let _pendingWheelTarget = null;

function _processPendingWheel() {
  _wheelRaf = 0;
  const e = _pendingWheelEvent;
  const target = _pendingWheelTarget;
  _pendingWheelEvent = null;
  _pendingWheelTarget = null;
  if (!e) return;

  if (target === dom.fragmentContainer) {
    if (e.ctrlKey || e.metaKey) {
      const containerRect = dom.fragmentContainer.getBoundingClientRect();
      const mouseXInContainer = e.clientX - containerRect.left;
      const beatWidth = getBeatWidth();
      const mouseBeats = (mouseXInContainer + state.fragmentScrollX) / beatWidth;

      const delta = e.deltaY > 0 ? 0.85 : 1.18;
      state.fragmentZoomX = Math.max(0.25, Math.min(4, state.fragmentZoomX * delta));

      const newBeatWidth = getBeatWidth();
      state.fragmentScrollX = mouseBeats * newBeatWidth - mouseXInContainer;
      renderFragmentTimeline();
    } else if (e.shiftKey) {
      state.fragmentScrollX += e.deltaY;
      // 审计修复：时间轴现在按可视区绘制（见 timelineRenderer 的 grid blit），
      // 滚动后新进入视野的区域必须重绘，只 syncFragmentScroll() 会留下空白。
      renderFragmentTimeline();
    } else {
      state.fragmentScrollY += e.deltaY;
      renderFragmentTimeline();
    }
  } else if (target === dom.singerListEl) {
    state.fragmentScrollY += e.deltaY;
    renderFragmentTimeline();
  }
}

dom.fragmentContainer.addEventListener('wheel', (e) => {
  e.preventDefault();
  _pendingWheelEvent = e;
  _pendingWheelTarget = dom.fragmentContainer;
  if (_wheelRaf) return;
  _wheelRaf = requestAnimationFrame(_processPendingWheel);
}, { passive: false });

dom.singerListEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  _pendingWheelEvent = e;
  _pendingWheelTarget = dom.singerListEl;
  if (_wheelRaf) return;
  _wheelRaf = requestAnimationFrame(_processPendingWheel);
}, { passive: false });

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    if (history.canUndo()) {
      history.undo();
      refreshAll();
    }
    return;
  }

  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey) || (e.key === 'Z' && e.shiftKey))) {
    e.preventDefault();
    if (history.canRedo()) {
      history.redo();
      refreshAll();
    }
    return;
  }

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.selectedFragmentId) {
      e.preventDefault();
      deleteSelectedFragment();
    }
    return;
  }
});

// Window beforeunload
window.addEventListener('beforeunload', () => {
  for (const cleanup of state._ipcCleanups) {
    try { cleanup(); } catch (_) {}
  }
  state._ipcCleanups.length = 0;
});

// Menu-driven save / save-as requests (sent from the main process File menu).
// The menu registers the Ctrl+S / Ctrl+Shift+S accelerators.
if (window.electronAPI?.onMainMenuSaveRequest) {
  const off1 = window.electronAPI.onMainMenuSaveRequest(() => { saveProject(); });
  if (state._ipcCleanups) state._ipcCleanups.push(off1);
}
if (window.electronAPI?.onMainMenuSaveAsRequest) {
  const off2 = window.electronAPI.onMainMenuSaveAsRequest(() => { saveProjectAs(); });
  if (state._ipcCleanups) state._ipcCleanups.push(off2);
}

// ---- Fragment context menu ----
let _fragmentCtxMenu = null;
let _ctxCloseHandler = null;
// 菜单弹出时刻：触屏长按抬起后浏览器仍会补发一次 click，若不忽略会立刻把
// 刚弹出的菜单关掉（"长按没反应"）。300ms 内的 click 一律忽略。
let _ctxMenuOpenedAt = 0;

function hideFragmentContextMenu() {
  if (_ctxCloseHandler) {
    document.removeEventListener('click', _ctxCloseHandler);
    _ctxCloseHandler = null;
  }
  if (_fragmentCtxMenu) {
    _fragmentCtxMenu.remove();
    _fragmentCtxMenu = null;
  }
}

function showFragmentContextMenu(clientX, clientY, fragment) {
  hideFragmentContextMenu();

  const menu = document.createElement('div');
  menu.className = 'fragment-ctx-menu';
  // 先按手指/指针落点定位，插入 DOM 后再按视口边界收敛 —— 避免在屏幕边缘
  // 长按（触屏上很常见）时菜单被裁到视口外、删除项点不到。
  menu.style.left = clientX + 'px';
  menu.style.top = clientY + 'px';
  menu.style.visibility = 'hidden';

  const deleteItem = document.createElement('div');
  deleteItem.className = 'fragment-ctx-item fragment-ctx-danger';
  deleteItem.textContent = t('main.deleteFragment');
  deleteItem.addEventListener('click', async () => {
    hideFragmentContextMenu();
    if (await showConfirmDialog(t('main.confirmDeleteFragment', { name: fragment.name }))) {
      deleteSelectedFragment();
    }
  });

  menu.appendChild(deleteItem);
  document.body.appendChild(menu);

  // 视口边界收敛（触屏边缘长按时不至于把菜单顶出屏幕）
  const rect = menu.getBoundingClientRect();
  const maxLeft = Math.max(0, window.innerWidth - rect.width - 8);
  const maxTop = Math.max(0, window.innerHeight - rect.height - 8);
  menu.style.left = Math.max(8, Math.min(clientX, maxLeft)) + 'px';
  menu.style.top = Math.max(8, Math.min(clientY, maxTop)) + 'px';
  menu.style.visibility = 'visible';

  _fragmentCtxMenu = menu;
  _ctxMenuOpenedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  // Close on click outside
  const closeHandler = (e) => {
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (now - _ctxMenuOpenedAt < 300) return;   // 忽略打开手势自身补发的 click
    if (!menu.contains(e.target)) {
      hideFragmentContextMenu();
    }
  };
  _ctxCloseHandler = closeHandler;
  setTimeout(() => {
    // 菜单可能已被关闭（例如又触发了一次长按），此时不必再挂监听。
    if (_ctxCloseHandler === closeHandler) document.addEventListener('click', closeHandler);
  }, 0);
}

// ---- Fragment deletion ----
async function deleteSelectedFragment() {
  const fragmentId = state.selectedFragmentId;
  if (!fragmentId) return;
  const fragment = trackManager.getFragment(fragmentId);
  if (!fragment) return;

  // Close fragment editor window if open
  if (window.electronAPI?.closeFragmentEditor) {
    window.electronAPI.closeFragmentEditor(fragmentId);
  }

  const fragmentClone = JSON.parse(JSON.stringify(fragment));
  const idx = trackManager.getFragments().findIndex(f => f.id === fragmentId);
  if (idx === -1) return;

  trackManager.removeFragment(fragmentId);
  state.selectedFragmentId = null;

  history.push({
    undo() {
      trackManager.addFragment(fragmentClone);
      // Re-insert at the original position
      const frags = trackManager.getFragments();
      const added = frags.pop();
      frags.splice(idx, 0, added);
      refreshAll();
    },
    redo() {
      trackManager.removeFragment(fragmentId);
      if (state.selectedFragmentId === fragmentId) {
        state.selectedFragmentId = null;
      }
      refreshAll();
    }
  });

  markDirty();
  refreshAll();
}
