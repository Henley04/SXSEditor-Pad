/**
 * SPA router — view switching + data handoff for the Tauri single-WebView shell.
 *
 * Replaces Electron's multi-window (BrowserWindow + IPC) model. Each former
 * "window" (fragment editor, singer creator, model download, …) is now a view
 * inside the single WebView. The bridge (src/tauri-bridge.js) calls
 * `navigate(route, data, params)` instead of `invoke('open_*')`; the target
 * view's controller reads its payload back via `consumeMail(route)`.
 *
 * The router is deliberately framework-agnostic so the upcoming Vue migration
 * can plug vue-router behind the same `navigate` / `consumeMail` / `onNavigate`
 * surface without touching call sites.
 *
 * Three primitives, matching the migration plan's "SPA 导航 + 信箱 + 事件":
 *   1. navigate(route, data, params)  — SPA navigation (hash + view URL)
 *   2. mailbox(route) / consumeMail   — 信箱 (cross-view data handoff)
 *   3. onNavigate(callback) + event   — 事件 (subscribers + DOM CustomEvent)
 *
 * Mailbox tiers:
 *   - In-memory Map     — survives within the same page (future Vue single-page).
 *   - sessionStorage     — survives a same-tab navigation to another built HTML
 *                           page (the current webpack multi-page layout emits
 *                           one bundle per view under dist/<view>/index.html).
 *   - Non-serializable payloads (Float32Array wav buffers, …) are kept in the
 *     in-memory tier only and additionally base64-mirrored into sessionStorage
 *     when they fit, so cross-page handoff still works for typical short clips.
 */

const MAILBOX_PREFIX = 'spa:mailbox:';
const NAV_EVENT = 'spa:navigate';

/**
 * Route registry. `url` is the view's HTML path relative to the dist root
 * (matches webpack's HtmlWebpackPlugin output: dist/<name>/index.html and
 * tauri.conf.json's main window URL `main_window/index.html`).
 */
const ROUTES = {
  main: { url: 'main_window/index.html' },
  'fragment-editor': { url: 'fragment_editor_window/index.html' },
  'singer-creator': { url: 'singer_creator_window/index.html' },
  'singer-market': { url: 'singer_market_window/index.html' },
  'audio-preprocess': { url: 'audio_preprocess_window/index.html' },
  settings: { url: 'settings_window/index.html' },
  'model-download': { url: 'model_download_window/index.html' },
  'resource-manager': { url: 'resource_manager_window/index.html' },
  splash: { url: 'splash_window/index.html' },
  'update-notification': { url: 'update_notification_window/index.html' },
};

const _listeners = new Set();
const _memoryMailbox = new Map();

let _currentRoute = parseRouteFromLocation();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseRouteFromLocation() {
  const href = (typeof window !== 'undefined' && window.location && window.location.href) || '';
  // Recognise `.../<window_dir>/index.html` (production) as well as a bare
  // `#route=...` hint used by tests / future in-page routing.
  for (const [name, entry] of Object.entries(ROUTES)) {
    if (href.includes(`/${entry.url}`) || href.endsWith(entry.url)) {
      return { name, params: parseHashParams(window.location.hash) };
    }
  }
  return { name: 'main', params: parseHashParams(window.location.hash) };
}

function parseHashParams(hash) {
  const params = {};
  if (!hash) return params;
  const q = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!q) return params;
  // Support both `key=value&key2=value2` and the legacy `fragmentId=xxx` form.
  new URLSearchParams(q).forEach((v, k) => { params[k] = v; });
  return params;
}

function buildHash(params) {
  if (!params) return '';
  const sp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) sp.set(k, String(v));
  });
  const s = sp.toString();
  return s ? `#${s}` : '';
}

/**
 * Resolve a route's view URL against the current page. The current page lives
 * at `<distRoot>/<curWindowDir>/index.html`; the target lives at
 * `<distRoot>/<routeUrl>`. Resolving via the parent directory keeps this
 * correct under the webpack dev server (http://localhost:5173/main_window/…)
 * and Tauri's asset protocol (tauri://localhost/main_window/…) alike.
 */
function resolveRouteHref(routeUrl, hash) {
  if (typeof window === 'undefined' || !window.location) return `../${routeUrl}${hash}`;
  const curHref = window.location.href;
  // Strip current filename → current window's directory.
  const curDir = curHref.replace(/[^/]*$/, '');
  // Go up one level to the dist root.
  const distRoot = curDir.replace(/[^/]+\/$/, '');
  try {
    return new URL(routeUrl, distRoot).href + (hash || '');
  } catch (_) {
    return `../${routeUrl}${hash || ''}`;
  }
}

function emitNavigate(route, data, params) {
  const payload = { route: { name: route, params: params || {} }, data, routeName: route };
  // Typed subscriber callback.
  _listeners.forEach((cb) => {
    try { cb(payload); } catch (_) { /* listener errors are isolated */ }
  });
  // DOM CustomEvent for fine-grained, per-view listeners (e.g. a controller
  // that only cares about its own route). Use `window.CustomEvent` so the
  // event is an instance of the same Event class jsdom / the browser dispatches
  // (a bare `new CustomEvent(...)` resolves to Node's global in tests, which
  // jsdom's `dispatchEvent` rejects).
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    const Ctor = window.CustomEvent || (typeof CustomEvent === 'function' ? CustomEvent : null);
    if (Ctor) {
      try {
        window.dispatchEvent(new Ctor(NAV_EVENT, { detail: payload }));
      } catch (_) { /* dispatch may be unavailable in some test envs */ }
    }
  }
}

function getSS() {
  // Prefer window.sessionStorage (browser + jsdom); fall back to the Node
  // global if a host has attached one. Returning null when absent makes the
  // mailbox gracefully degrade to in-memory only.
  if (typeof window !== 'undefined' && window.sessionStorage) return window.sessionStorage;
  if (typeof globalThis !== 'undefined' && globalThis.sessionStorage) return globalThis.sessionStorage;
  return null;
}

function sessionStorageSet(key, value) {
  try {
    const ss = getSS();
    if (!ss) return false;
    ss.setItem(key, value);
    return true;
  } catch (_) {
    // QuotaExceededError / SecurityError — fall back to in-memory only.
    return false;
  }
}

function sessionStorageGet(key) {
  try {
    const ss = getSS();
    if (!ss) return null;
    return ss.getItem(key);
  } catch (_) {
    return null;
  }
}

function sessionStorageDel(key) {
  try {
    const ss = getSS();
    if (!ss) return;
    ss.removeItem(key);
  } catch (_) { /* noop */ }
}

// Typed-array constructors we can round-trip. `BYTES_PER_ELEMENT` lets us
// recover the element count from the byte length.
const TYPED_ARRAY_KINDS = {
  Float32Array: Float32Array,
  Float64Array: Float64Array,
  Int8Array: Int8Array,
  Uint8Array: Uint8Array,
  Int16Array: Int16Array,
  Uint16Array: Uint16Array,
  Int32Array: Int32Array,
  Uint32Array: Uint32Array,
};

const TA_MARKER = '$__ta';
const TA_B64 = '$__b64';
const TA_LEN = '$__byteLength';
// Conservative sessionStorage budget per typed array. Payloads larger than
// this stay in the in-memory tier only (cross-page handoff degrades to null).
const TA_MAX_BYTES = 4 * 1024 * 1024;

function b64Encode(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  const b64Fn = (typeof btoa === 'function')
    ? btoa
    : (typeof globalThis !== 'undefined' && typeof globalThis.btoa === 'function')
      ? globalThis.btoa
      : null;
  return b64Fn ? b64Fn(bin) : Buffer.from(bytes).toString('base64');
}

function b64Decode(b64) {
  const atobFn = (typeof atob === 'function')
    ? atob
    : (typeof globalThis !== 'undefined' && typeof globalThis.atob === 'function')
      ? globalThis.atob
      : null;
  const bin = atobFn ? atobFn(b64) : Buffer.from(b64, 'base64').toString('binary');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Deep-replace every typed array / ArrayBuffer inside `value` with a marker
 * object `{$__ta, $__b64, $__byteLength}` that survives JSON.stringify. The
 * mirror recursion is bounded by TA_MAX_BYTES per array: larger arrays are
 * left in place (so the in-memory tier still serves them) and dropped from
 * the JSON mirror by converting them to `null` (with a marker indicating
 * the array was elided).
 *
 * Returns `null` when the structure cannot be mirrored (cycle, very large,
 * non-cloneable). The caller then keeps the payload in-memory only.
 */
function deepEncode(value, seen) {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'function' || t === 'symbol') return null;
  if (t !== 'object') return value;
  if (ArrayBuffer.isView(value)) {
    const kind = value.constructor && value.constructor.name;
    const Ctor = kind && TYPED_ARRAY_KINDS[kind];
    if (!Ctor) return null;
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (bytes.length > TA_MAX_BYTES) {
      // Too large: elide from the mirror (in-memory tier still holds it).
      return { [TA_MARKER]: kind, [TA_B64]: null, [TA_LEN]: bytes.length };
    }
    return { [TA_MARKER]: kind, [TA_B64]: b64Encode(bytes), [TA_LEN]: bytes.length };
  }
  if (value instanceof ArrayBuffer) {
    const bytes = new Uint8Array(value);
    if (bytes.length > TA_MAX_BYTES) return null;
    return { [TA_MARKER]: 'ArrayBuffer', [TA_B64]: b64Encode(bytes), [TA_LEN]: bytes.length };
  }
  // Cycle guard.
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((v) => deepEncode(v, seen));
  }
  const out = {};
  for (const k of Object.keys(value)) {
    out[k] = deepEncode(value[k], seen);
  }
  return out;
}

function deepDecode(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  // Marker object?
  if (value[TA_MARKER] && TA_B64 in value) {
    const kind = value[TA_MARKER];
    const b64 = value[TA_B64];
    if (b64 === null) return null; // elided (oversized)
    const bytes = b64Decode(b64);
    const Ctor = TYPED_ARRAY_KINDS[kind];
    if (Ctor) {
      return new Ctor(bytes.buffer, bytes.byteOffset, bytes.byteLength / Ctor.BYTES_PER_ELEMENT);
    }
    if (kind === 'ArrayBuffer') return bytes.buffer;
    return bytes.buffer;
  }
  if (Array.isArray(value)) {
    return value.map((v) => deepDecode(v));
  }
  const out = {};
  for (const k of Object.keys(value)) {
    out[k] = deepDecode(value[k]);
  }
  return out;
}

function encodeForMailbox(value) {
  if (value === undefined) return { stored: null, kind: 'none' };
  try {
    const mirrored = deepEncode(value, new Set());
    if (mirrored === null) {
      // Deep encode gave up (cycle / function). Keep in-memory only.
      return { stored: null, kind: 'memory-only' };
    }
    return { stored: JSON.stringify(mirrored), kind: 'json' };
  } catch (_) {
    return { stored: null, kind: 'memory-only' };
  }
}

function decodeFromMailbox(raw) {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    return deepDecode(parsed);
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Navigate to a route.
 *
 * @param {string} route  Route name (key of ROUTES).
 * @param {*}      [data] Optional payload stashed in the mailbox for the
 *                        target view to consume via `consumeMail(route)`.
 * @param {Object} [params] Route params serialised into the URL hash (e.g.
 *                          `{ fragmentId: 'abc' }` → `#fragmentId=abc`).
 * @returns {{routeName: string, href: string}|null} navigation descriptor, or
 *          null if the route is unknown.
 */
export function navigate(route, data, params) {
  const entry = ROUTES[route];
  if (!entry) {
    if (typeof console !== 'undefined') {
      console.warn(`[spa] unknown route: ${route}`);
    }
    return null;
  }
  // Mailbox: stash the payload both in-memory (same-page SPA) and in
  // sessionStorage (cross-page navigation in the current multi-page build).
  if (data !== undefined) {
    _memoryMailbox.set(route, data);
    const { stored } = encodeForMailbox(data);
    if (stored !== null) {
      sessionStorageSet(MAILBOX_PREFIX + route, stored);
    }
  }
  const hash = buildHash(params);
  _currentRoute = { name: route, params: params || {} };
  const href = resolveRouteHref(entry.url, hash);
  // Event fires BEFORE the page navigates, so same-page listeners can react.
  emitNavigate(route, data, params || {});
  // Perform the navigation. In the current multi-page build this loads the
  // target view's HTML; once vue-router is wired in, swap this hook for
  // `router.push()` and the rest of the surface stays unchanged. The
  // assignment is wrapped so a host that blocks full-page navigation (jsdom,
  // sandboxed iframes) still gets the mailbox + event side effects.
  if (typeof window !== 'undefined' && window.location && href !== window.location.href) {
    try {
      window.location.href = href;
    } catch (_) {
      // Navigation blocked by the host — record the intent and rely on the
      // mailbox/event handoff for same-page SPA consumers.
    }
  }
  return { routeName: route, href };
}

/**
 * Pop and return the mailbox entry for a route (in-memory first, then
 * sessionStorage). The entry is removed after reading — one-shot handoff.
 */
export function consumeMail(route) {
  if (_memoryMailbox.has(route)) {
    const v = _memoryMailbox.get(route);
    _memoryMailbox.delete(route);
    sessionStorageDel(MAILBOX_PREFIX + route);
    return v;
  }
  const raw = sessionStorageGet(MAILBOX_PREFIX + route);
  if (raw != null) {
    sessionStorageDel(MAILBOX_PREFIX + route);
    return decodeFromMailbox(raw);
  }
  return null;
}

/** Non-destructive read of the mailbox entry for a route. */
export function peekMail(route) {
  if (_memoryMailbox.has(route)) return _memoryMailbox.get(route);
  const raw = sessionStorageGet(MAILBOX_PREFIX + route);
  return raw != null ? decodeFromMailbox(raw) : null;
}

/** Stash a payload without navigating (used when the target view polls). */
export function mailbox(route, data) {
  if (data === undefined) {
    return peekMail(route);
  }
  _memoryMailbox.set(route, data);
  const { stored } = encodeForMailbox(data);
  if (stored !== null) {
    sessionStorageSet(MAILBOX_PREFIX + route, stored);
  }
  return data;
}

/** Subscribe to navigation events. Returns an unsubscribe function. */
export function onNavigate(callback) {
  if (typeof callback !== 'function') return () => {};
  _listeners.add(callback);
  return () => _listeners.delete(callback);
}

/** Current route descriptor. */
export function getCurrentRoute() {
  return _currentRoute;
}

/** List registered route names (read-only). */
export function listRoutes() {
  return Object.keys(ROUTES);
}

/** Resolve a route's view URL without navigating (used by tests / deep links). */
export function resolveRouteUrl(route) {
  const entry = ROUTES[route];
  return entry ? entry.url : null;
}

/** Mailbox codec (deep typed-array-aware). Exported for tests / debugging. */
export const _mailboxCodec = { encode: encodeForMailbox, decode: decodeFromMailbox };

/**
 * Sync the router with a hashchange (back/forward). Re-parses the current
 * route from the URL so `getCurrentRoute()` stays accurate after the user
 * uses browser history. Safe to call multiple times.
 */
export function syncFromLocation() {
  _currentRoute = parseRouteFromLocation();
  return _currentRoute;
}

// Auto-attach to browser history when running in a real DOM.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('hashchange', () => {
    // Only re-derive the route; navigation itself was already triggered.
    _currentRoute = parseRouteFromLocation();
  });
}

// Test/debug hook: clears all mailbox state. Not part of the public surface
// used by the app; exported so the test suite can reset between cases.
export function _resetForTest() {
  _memoryMailbox.clear();
  _listeners.clear();
  const ss = getSS();
  if (ss) {
    try {
      Object.keys(ss)
        .filter((k) => k.startsWith(MAILBOX_PREFIX))
        .forEach((k) => ss.removeItem(k));
    } catch (_) { /* noop */ }
  }
  _currentRoute = parseRouteFromLocation();
}

export default {
  navigate,
  consumeMail,
  peekMail,
  mailbox,
  onNavigate,
  getCurrentRoute,
  listRoutes,
  resolveRouteUrl,
  syncFromLocation,
  _resetForTest,
};
