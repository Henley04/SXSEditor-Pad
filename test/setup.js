require('@babel/register')({
  presets: ['@babel/preset-env'],
  ignore: [/node_modules/],
});

const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost',
});
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.HTMLCanvasElement = dom.window.HTMLCanvasElement;
Object.defineProperty(global, 'navigator', {
  value: dom.window.navigator,
  writable: true,
  configurable: true,
});

// 模拟 canvas getContext
HTMLCanvasElement.prototype.getContext = function() {
  return {
    fillRect: function() {},
    clearRect: function() {},
    getImageData: function(x, y, w, h) {
      return { data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData: function() {},
    createImageData: function() { return []; },
    setTransform: function() {},
    drawImage: function() {},
    save: function() {},
    fillText: function() {},
    restore: function() {},
    beginPath: function() {},
    moveTo: function() {},
    lineTo: function() {},
    closePath: function() {},
    stroke: function() {},
    translate: function() {},
    scale: function() {},
    rotate: function() {},
    arc: function() {},
    fill: function() {},
    measureText: function() {
      return { width: 0 };
    },
    transform: function() {},
    rect: function() {},
    clip: function() {},
  };
};

const sinon = require('sinon');

// Polyfill CustomEvent for JSDOM
if (typeof global.CustomEvent === 'undefined') {
  global.CustomEvent = class CustomEvent extends Event {
    constructor(type, options = {}) {
      super(type, options);
      this.detail = options.detail || null;
    }
  };
}

// Register SVGElement global for JSDOM
if (typeof global.SVGElement === 'undefined') {
  global.SVGElement = dom.window.SVGElement;
}

// Module loader mock for test environment.
// The Tauri refactor removed all Electron main-process code, so no source file
// requires('electron') anymore. We still mock onnxruntime-node because several
// inference/pipeline reference modules load it at module top-level; in CI
// (--ignore-scripts) the native binding is absent, and these modules are kept
// only as tested pure-logic reference implementations (not bundled into the
// renderer, which uses onnxruntime-web via src/inference/webnn).
const Module = require('module');
const _originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'onnxruntime-node' || request === 'onnxruntime-common') {
    const env = { logLevel: 'error', debug: false };
    return {
      env,
      InferenceSession: {
        create: async () => ({ run: async () => ({}) }),
      },
      Tensor: function (type, data, dims) {
        this.type = type;
        this.data = data;
        this.dims = dims;
        this.size = data ? data.length : 0;
      },
    };
  }
  return _originalLoad.apply(this, arguments);
};

// Mocha root hook 插件，提供 sinon sandbox 自动清理
let _sinonSandbox;
exports.mochaHooks = {
  beforeEach() {
    _sinonSandbox = sinon.createSandbox();
  },
  afterEach() {
    if (_sinonSandbox) {
      _sinonSandbox.restore();
      _sinonSandbox = null;
    }
  },
};
