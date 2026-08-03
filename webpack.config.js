const path = require('path');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const CopyPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');

const WINDOW_NAMES = [
  'main_window',
  'fragment_editor_window',
  'singer_creator_window',
  'singer_market_window',
  'audio_preprocess_window',
  'settings_window',
  'model_download_window',
  'resource_manager_window',
  'splash_window',
  'update_notification_window',
];

// Windows that need onnxruntime-web wasm/JS files copied alongside
const ONNX_WINDOW_NAMES = WINDOW_NAMES.filter(
  (n) => !['splash_window', 'singer_market_window', 'update_notification_window'].includes(n)
);

// HTML template mapping (name -> src template path)
const HTML_TEMPLATES = {
  'main_window': 'src/index.html',
  'fragment_editor_window': 'src/fragmentEditor.html',
  'singer_creator_window': 'src/singerCreator.html',
  'singer_market_window': 'src/singerMarket.html',
  'audio_preprocess_window': 'src/audioPreprocess.html',
  'settings_window': 'src/settings.html',
  'model_download_window': 'src/modelDownload.html',
  'resource_manager_window': 'src/resourceManager.html',
  'splash_window': 'src/splash.html',
  'update_notification_window': 'src/updateNotification.html',
};

module.exports = {
  mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  target: 'web',
  entry: {
    'main_window': ['./src/tauri-bridge.js', './src/renderer/index.js'],
    'fragment_editor_window': ['./src/tauri-bridge.js', './src/fragmentEditor/index.js'],
    'singer_creator_window': ['./src/tauri-bridge.js', './src/singerCreator.js'],
    'singer_market_window': ['./src/tauri-bridge.js', './src/singerMarket.js'],
    'audio_preprocess_window': ['./src/tauri-bridge.js', './src/audioPreprocess/index.js'],
    'settings_window': ['./src/tauri-bridge.js', './src/settings.js'],
    'model_download_window': ['./src/tauri-bridge.js', './src/modelDownload.js'],
    'resource_manager_window': ['./src/tauri-bridge.js', './src/resourceManager.js'],
    'splash_window': './src/splash.js',
    'update_notification_window': ['./src/tauri-bridge.js', './src/updateNotification.js'],
  },
  module: {
    rules: [
      {
        test: /\.css$/,
        use: [MiniCssExtractPlugin.loader, 'css-loader'],
      },
      {
        test: /\.js$/,
        exclude: /(node_modules|\.webpack)/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-env'],
          },
        },
      },
    ],
  },
  plugins: [
    new MiniCssExtractPlugin({
      filename: '[name]/style.css',
    }),
    // Generate HTML files for each window with the correct bundle.
    // viewport meta is injected here (rather than in each src/*.html) so all
    // 10 windows get a consistent mobile viewport in one place. Without it,
    // Android WebView defaults to a ~980px layout viewport, shrinking the
    // whole UI and breaking every @media (max-width) breakpoint below that —
    // the direct cause of "buttons overlap on phone". viewport-fit=cover
    // lets content extend into the notch area (paired with safe-area insets
    // already declared in pad.css).
    ...Object.entries(HTML_TEMPLATES).map(([name, template]) => new HtmlWebpackPlugin({
      template: path.resolve(__dirname, template),
      filename: `${name}/index.html`,
      chunks: [name],
      inject: 'body',
      scriptLoading: 'blocking',
      meta: {
        viewport: 'width=device-width, initial-scale=1.0, viewport-fit=cover',
      },
    })),
    new CopyPlugin({
      patterns: [
        ...WINDOW_NAMES.map((name) => ({
          from: path.resolve(__dirname, 'src/themes/themeBootstrap.js'),
          to: path.resolve(__dirname, `dist/${name}/themes/themeBootstrap.js`),
        })),
        {
          from: path.resolve(__dirname, 'assets/SXS.png'),
          to: path.resolve(__dirname, 'dist/splash_window/SXS.png'),
          noErrorOnMissing: true,
        },
        ...ONNX_WINDOW_NAMES.flatMap((name) => {
          const ortDist = path.resolve(__dirname, 'node_modules/onnxruntime-web/dist');
          return [
            {
              from: '*.wasm',
              to: path.resolve(__dirname, `dist/${name}/[name][ext]`),
              context: ortDist,
              noErrorOnMissing: true,
            },
            {
              from: 'ort-wasm*.{js,mjs}',
              to: path.resolve(__dirname, `dist/${name}/[name][ext]`),
              context: ortDist,
              noErrorOnMissing: true,
            },
            {
              from: path.resolve(__dirname, 'node_modules/onnxruntime-web/dist/ort.all.min.js'),
              to: path.resolve(__dirname, `dist/${name}/ort.all.min.js`),
              noErrorOnMissing: true,
            },
          ];
        }),
        ...WINDOW_NAMES.map((name) => ({
          from: path.resolve(__dirname, 'src/tauri-bridge.js'),
          to: path.resolve(__dirname, `dist/${name}/tauri-bridge.js`),
        })),
        ...WINDOW_NAMES.map((name) => ({
          from: path.resolve(__dirname, 'src/pad.css'),
          to: path.resolve(__dirname, `dist/${name}/pad.css`),
        })),
      ],
    }),
  ],
  resolve: {
    extensions: ['.js', '.css', '.json'],
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name]/[name].js',
    publicPath: '/',
    clean: true,
  },
  devServer: {
    static: {
      directory: path.resolve(__dirname, 'dist'),
    },
    port: 5173,
    hot: false,
    liveReload: false,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
};