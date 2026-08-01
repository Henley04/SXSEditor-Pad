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

// Global electron mock for test environment
// Many source files require('electron') at load time. We provide a minimal stub
// so tests can require those modules without crashing.
const Module = require('module');
const _originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getPath: () => '/tmp/sxseditor-test',
        getVersion: () => '0.0.0-test',
        isPackaged: false,
        on: () => {},
        quit: () => {},
      },
      ipcMain: {
        on: () => {},
        handle: () => {},
        handleOnce: () => {},
        removeListener: () => {},
      },
      BrowserWindow: {
        getAllWindows: () => [],
        getFocusedWindow: () => null,
      },
      dialog: {
        showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
        showSaveDialog: () => Promise.resolve({ canceled: true, filePath: '' }),
      },
      shell: { openExternal: () => Promise.resolve() },
      contextBridge: { exposeInMainWorld: () => {} },
      ipcRenderer: {
        on: () => {},
        send: () => {},
        invoke: () => Promise.resolve(),
        removeListener: () => {},
      },
      session: { defaultSession: null },
      net: { request: () => {} },
      Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
      protocol: { registerFileProtocol: () => {} },
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
