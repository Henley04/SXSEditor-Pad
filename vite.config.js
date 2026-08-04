/**
 * SXSEditor-Pad — Vite build configuration.
 *
 * Replaces webpack.config.js. Builds the 10-window multi-page Tauri frontend
 * (one HTML bundle per former "window" / SPA route) with Vue 3 available as
 * the incremental UI layer. Existing vanilla-JS modules continue to run via
 * side-effect imports from each window's entry (src/entries/*.js).
 *
 * Output layout matches the webpack output so the SPA router
 * (src/spa/router.js ROUTES registry) and tauri.conf.json window URL
 * (`main_window/index.html`) keep working without changes:
 *
 *   dist/<window_name>/index.html
 *   dist/<window_name>/themes/themeBootstrap.js   (copied, non-module)
 *   dist/<window_name>/*.wasm / ort-wasm*.*        (ONNX windows only)
 *   dist/assets/<chunk>-<hash>.js                   (shared JS chunks)
 */
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import commonjs from '@rollup/plugin-commonjs';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Window → source HTML mapping -----------------------------------------
// The input key uses a slash (`<window>/index`) so Vite emits the HTML at
// `dist/<window>/index.html`, matching the layout the SPA router expects.
const WINDOW_ENTRIES = {
  'main_window/index': path.resolve(__dirname, 'src/index.html'),
  'fragment_editor_window/index': path.resolve(__dirname, 'src/fragmentEditor.html'),
  'singer_creator_window/index': path.resolve(__dirname, 'src/singerCreator.html'),
  'singer_market_window/index': path.resolve(__dirname, 'src/singerMarket.html'),
  'audio_preprocess_window/index': path.resolve(__dirname, 'src/audioPreprocess.html'),
  'settings_window/index': path.resolve(__dirname, 'src/settings.html'),
  'model_download_window/index': path.resolve(__dirname, 'src/modelDownload.html'),
  'resource_manager_window/index': path.resolve(__dirname, 'src/resourceManager.html'),
  'splash_window/index': path.resolve(__dirname, 'src/splash.html'),
  'update_notification_window/index': path.resolve(__dirname, 'src/updateNotification.html'),
};

const ALL_WINDOW_DIRS = Object.keys(WINDOW_ENTRIES).map((k) => k.split('/')[0]);

// Windows that load onnxruntime-web and need its wasm/JS glue copied
// alongside the HTML (excludes splash / singer-market / update-notification
// which never touch ONNX — mirrors webpack.config.js ONNX_WINDOW_NAMES).
const ONNX_WINDOW_DIRS = ALL_WINDOW_DIRS.filter(
  (n) => !['splash_window', 'singer_market_window', 'update_notification_window'].includes(n)
);

// ---- Dev-server URL rewriter -----------------------------------------------
// Tauri opens `http://localhost:5173/<window>/index.html`, but Vite's dev
// server serves source HTML from /src/<file>.html. This middleware rewrites
// the request URL so the correct source file is served, and also rewrites
// relative asset requests (./entries/*.js, ./themes/themeBootstrap.js, …)
// so they resolve back into /src/ where Vite can transform them.
function devWindowRouter() {
  const HTML_MAP = {
    '/main_window/index.html': '/src/index.html',
    '/fragment_editor_window/index.html': '/src/fragmentEditor.html',
    '/singer_creator_window/index.html': '/src/singerCreator.html',
    '/singer_market_window/index.html': '/src/singerMarket.html',
    '/audio_preprocess_window/index.html': '/src/audioPreprocess.html',
    '/settings_window/index.html': '/src/settings.html',
    '/model_download_window/index.html': '/src/modelDownload.html',
    '/resource_manager_window/index.html': '/src/resourceManager.html',
    '/splash_window/index.html': '/src/splash.html',
    '/update_notification_window/index.html': '/src/updateNotification.html',
  };

  return {
    name: 'sxs-dev-window-router',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const raw = req.url || '';
        const url = raw.split('?')[0];

        // HTML entry rewrite.
        if (HTML_MAP[url]) {
          req.url = HTML_MAP[url] + (raw.includes('?') ? '?' + raw.split('?')[1] : '');
          return next();
        }

        // Splash icon: /splash_window/SXS.png → /assets/SXS.png (project root).
        if (url === '/splash_window/SXS.png') {
          req.url = '/assets/SXS.png';
          return next();
        }

        // Generic relative-asset rewrite: /<window>/<path> → /src/<path>.
        // Covers ./entries/*.js, ./themes/themeBootstrap.js, and any other
        // relative reference inside a window's HTML.
        for (const winDir of ALL_WINDOW_DIRS) {
          const prefix = `/${winDir}/`;
          if (url.startsWith(prefix)) {
            req.url = '/src/' + url.slice(prefix.length);
            return next();
          }
        }

        next();
      });
    },
  };
}

// Source HTML filename → window output directory. Vite emits HTML files
// at dist/src/<file>.html based on the source path (src/index.html →
// dist/src/index.html), NOT at the rollupOptions.input key path. This
// mapping is used to move them to dist/<window>/index.html so the SPA
// router and tauri.conf.json window URLs resolve correctly.
const HTML_FILE_TO_WINDOW = {
  'index.html': 'main_window',
  'fragmentEditor.html': 'fragment_editor_window',
  'singerCreator.html': 'singer_creator_window',
  'singerMarket.html': 'singer_market_window',
  'audioPreprocess.html': 'audio_preprocess_window',
  'settings.html': 'settings_window',
  'modelDownload.html': 'model_download_window',
  'resourceManager.html': 'resource_manager_window',
  'splash.html': 'splash_window',
  'updateNotification.html': 'update_notification_window',
};

// ---- Build-time asset copier -----------------------------------------------
// Mirrors webpack CopyPlugin: copies themeBootstrap.js (referenced as a
// non-module <script> in each HTML head) and onnxruntime-web wasm/JS glue
// into each window's dist subdirectory after the bundle is written.
// Also moves the emitted HTML files from dist/src/<file>.html to
// dist/<window>/index.html (see HTML_FILE_TO_WINDOW comment above).
function copyWindowAssets() {
  return {
    name: 'sxs-copy-window-assets',
    apply: 'build',
    closeBundle() {
      const distRoot = path.resolve(__dirname, 'dist');
      if (!fs.existsSync(distRoot)) return;

      // Move HTML files: Vite emits them at dist/src/<file>.html based on
      // the source file path, but the SPA router / Tauri config expects
      // dist/<window>/index.html. Relative asset refs inside the HTML
      // (../assets/..., ./themes/..., ./SXS.png) stay valid because both
      // paths are one level deep under dist/.
      const srcHtmlDir = path.join(distRoot, 'src');
      if (fs.existsSync(srcHtmlDir)) {
        for (const fileName of Object.keys(HTML_FILE_TO_WINDOW)) {
          const srcPath = path.join(srcHtmlDir, fileName);
          if (!fs.existsSync(srcPath)) continue;
          const windowDir = HTML_FILE_TO_WINDOW[fileName];
          const winDist = path.join(distRoot, windowDir);
          if (!fs.existsSync(winDist)) fs.mkdirSync(winDist, { recursive: true });
          fs.copyFileSync(srcPath, path.join(winDist, 'index.html'));
          fs.unlinkSync(srcPath);
        }
        const remaining = fs.readdirSync(srcHtmlDir);
        if (remaining.length === 0) {
          fs.rmdirSync(srcHtmlDir);
        }
      }

      // themeBootstrap.js → dist/<window>/themes/themeBootstrap.js
      const bootstrapSrc = path.resolve(__dirname, 'src/themes/themeBootstrap.js');
      for (const winDir of ALL_WINDOW_DIRS) {
        const themesDir = path.join(distRoot, winDir, 'themes');
        if (!fs.existsSync(themesDir)) fs.mkdirSync(themesDir, { recursive: true });
        if (fs.existsSync(bootstrapSrc)) {
          fs.copyFileSync(bootstrapSrc, path.join(themesDir, 'themeBootstrap.js'));
        }
      }

      // onnxruntime-web wasm/JS → dist/<onnx_window>/
      const ortDist = path.resolve(__dirname, 'node_modules/onnxruntime-web/dist');
      if (fs.existsSync(ortDist)) {
        const ortFiles = fs.readdirSync(ortDist);
        const ortCopyList = ortFiles.filter(
          (f) => f.endsWith('.wasm') || f.startsWith('ort-wasm') || f === 'ort.all.min.js'
        );
        for (const winDir of ONNX_WINDOW_DIRS) {
          const winDist = path.join(distRoot, winDir);
          if (!fs.existsSync(winDist)) continue;
          for (const file of ortCopyList) {
            const src = path.join(ortDist, file);
            const dst = path.join(winDist, file);
            try {
              fs.copyFileSync(src, dst);
            } catch (_) {
              // noErrorOnMissing equivalent — keep going.
            }
          }
        }
      }

      // SXS.png → dist/splash_window/SXS.png (splash icon)
      const sxsPng = path.resolve(__dirname, 'assets/SXS.png');
      if (fs.existsSync(sxsPng)) {
        const splashDist = path.join(distRoot, 'splash_window');
        if (fs.existsSync(splashDist)) {
          fs.copyFileSync(sxsPng, path.join(splashDist, 'SXS.png'));
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [
    // Handle CommonJS source files (module.exports) that are imported via
    // ES `import` by renderer modules. Webpack did this automatically;
    // Rollup needs the explicit plugin. Includes src/ and scripts/ so all
    // first-party CJS modules (utils, audio, inference/pipeline, …) resolve.
    commonjs({
      include: [/src\/.*\.js$/, /scripts\/.*\.js$/],
      requireReturnsDefault: 'preferred',
    }),
    vue(),
    devWindowRouter(),
    copyWindowAssets(),
  ],
  // Relative base so multi-page HTML at dist/<window>/index.html resolves
  // shared assets (../assets/…) correctly under both Tauri's asset protocol
  // and a static file server.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Keep chunk names readable for debugging; Vite hashes them for cache busting.
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: WINDOW_ENTRIES,
      output: {
        // Group shared modules (Vue, Tauri API, ONNX glue) into shared chunks
        // so they're loaded once and cached across window navigations.
        manualChunks: {
          vue: ['vue'],
          tauri: [
            '@tauri-apps/api/core',
            '@tauri-apps/api/event',
            '@tauri-apps/plugin-fs',
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // COOP/COEP required by onnxruntime-web for SharedArrayBuffer (multi-threaded wasm).
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    // Allow serving /assets/SXS.png from the project root in dev mode.
    fs: {
      allow: [__dirname],
    },
  },
  resolve: {
    extensions: ['.js', '.css', '.json', '.vue'],
  },
});
