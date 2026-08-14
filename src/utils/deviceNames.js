/**
 * 硬件设备名称解析 — 供初次启动硬件检测等入口复用。
 *
 * 优先使用 Rust 后端上报的真实设备信息（SoC/CPU 型号、加速器集合），
 * 仅在原生信息不可用时回退到 User-Agent / WebGL 的猜测。
 */

/**
 * 加速器行标签。原生后端下 NNAPI（Android）/ CoreML（iOS）是同一套加速器
 * EP，这里用 EP 名称而非编造的厂商 GPU 字符串。
 * @param {object|null} deviceInfo - { accelerators: { nnapi, coreml, dsp } }
 * @param {'NPU'|'DSP'|string} kind
 * @returns {string}
 */
export function acceleratorLabel(deviceInfo, kind) {
  const acc = (deviceInfo && deviceInfo.accelerators) || {};
  if (acc.coreml) {
    return kind === 'NPU' ? 'CoreML (ANE)' : 'CoreML';
  }
  if (acc.nnapi) {
    return kind === 'DSP' ? 'NNAPI (Hexagon/QDSP)' : 'NNAPI';
  }
  return kind;
}

/**
 * CPU / SoC 名称。优先原生上报，其次解析 UA，最后回退为核心数。
 * @param {object|null} deviceInfo - { cpuName?: string }
 * @returns {string}
 */
export function getCPUName(deviceInfo) {
  if (deviceInfo && deviceInfo.cpuName) return deviceInfo.cpuName;
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  // 只解析 UA 第一个括号平台段，避免把 "AppleWebKit/537.36 ..." 误判成 CPU：
  //   "Macintosh; Intel Mac OS X 10_15_7"
  //   "Windows NT 10.0; Win64; x64"
  //   "Linux; Android 14; SM-S928B Build/UP1A"
  //   "iPhone; CPU iPhone OS 17_2 like Mac OS X"
  const blockMatch = ua.match(/\(([^)]+)\)/);
  if (blockMatch) {
    const block = blockMatch[1];
    // Android：取 Android 版本号后的设备型号（SM-S928B 等）。
    const android = block.match(/Android[\s\d_.]*;\s*([^;\s]+)/i);
    if (android) return android[1];
    // iOS：iPhone / iPad。
    const ios = block.match(/(iPhone|iPad)/i);
    if (ios) return ios[1];
    // 桌面 CPU：去掉 "Mac OS X 10_15_7" 与 "CPU @ 2.60GHz" 噪声。
    const cpu = block.match(/(Intel|AMD|Apple|Snapdragon|Exynos|Kirin|Dimensity|MediaTek|Tensor)[^;]*/i);
    if (cpu) {
      return cpu[0]
        .replace(/\s*Mac OS X[\s\d_]*/i, '')
        .replace(/\s*(?:CPU\s*)?@\s*[\d.]+\s*GHz/i, '')
        .trim();
    }
    // Windows NT 版本。
    const win = block.match(/Windows NT [\d.]+/i);
    if (win) return win[0];
  }
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || undefined;
  return `${cores || '?'} 核 CPU`;
}

/**
 * GPU 名称。优先原生上报，其次用加速器 EP 标签，最后（仅纯浏览器开发环境）
 * 用 WebGL 渲染器名。
 * @param {object|null} deviceInfo - { gpuName?: string, accelerators: { nnapi, coreml } }
 * @returns {string}
 */
export function getGPUName(deviceInfo) {
  if (deviceInfo && deviceInfo.gpuName) return deviceInfo.gpuName;
  const acc = (deviceInfo && deviceInfo.accelerators) || {};
  if (acc.coreml) return 'CoreML (ANE/GPU)';
  if (acc.nnapi) return 'NNAPI (GPU/DSP)';
  // 纯浏览器开发回退（无原生后端）：真实 WebGL 渲染器名。
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl) {
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
        if (renderer) return renderer;
      }
    }
  }
  return 'GPU';
}