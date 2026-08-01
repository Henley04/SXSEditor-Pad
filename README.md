<div align="center">

  <img src="assets/SXS.png" alt="SXSEditor-Pad" width="80" height="80" style="border-radius:16px"/>

  # SXSEditor-Pad

  **AI Singing Voice Synthesis Workstation for Mobile Devices**

  [![Version](https://img.shields.io/badge/version-1.0.0-blue?style=flat-square)](https://github.com/Henley04/SXSEditor-Pad/releases)
  [![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
  [![Platform](https://img.shields.io/badge/platform-Android%20|%20iOS%20|%20Desktop-lightgrey?style=flat-square)]()
  [![Build](https://img.shields.io/github/actions/workflow/status/Henley04/SXSEditor-Pad/build-apk.yml?branch=master&style=flat-square)](https://github.com/Henley04/SXSEditor-Pad/actions)
  [![SVS Languages](https://img.shields.io/badge/SVS-EN%20|%20ZH%20|%20JP-orange?style=flat-square)]()

</div>

---

SXSEditor-Pad is a mobile-optimized port of [SXSEditor](https://github.com/Henley04/SXSEditor), built with **Tauri v2** for cross-platform mobile and desktop support. It is an open-source singing voice synthesis workstation that runs the SoulX-Singer neural model through ONNX Runtime Web with WebNN NPU/GPU acceleration.

Supported singing languages: **English**, **Chinese (Mandarin)**, and **Japanese**.

## Features

- **Multi-track timeline editor** for composing vocal arrangements
- **Fragment editor** with fine-grained note and phoneme control
- **Audio-to-MIDI conversion** using Basic Pitch or RMVPE
- **Singer management** with market for sharing voice models
- **Real-time preview** with adjustable inference parameters
- **High-quality export** in WAV format
- **Theme system** with customizable color schemes
- **Touch-optimized UI** designed for tablet devices
- **Full toolbar** preserving all desktop functionality

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | [Tauri v2](https://v2.tauri.app/) (Rust + WebView) |
| Frontend | Vanilla JavaScript, CSS3, HTML5 |
| Bundler | Webpack 5 with HtmlWebpackPlugin |
| Model Runtime | ONNX Runtime Web (WebNN / WASM) |
| Additional AI | TensorFlow.js (Basic Pitch) |
| Backend | Rust with Tauri plugins |
| Mobile | Android (APK) / iOS (IPA) |

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://www.rust-lang.org/) (latest stable)
- [Tauri CLI](https://v2.tauri.app/start/cli/) (`cargo install tauri-cli --version "^2.0"`)
- For Android builds: Android SDK, NDK, JDK 17
- For iOS builds: macOS, Xcode, CocoaPods

## Quick Start

```bash
# Clone the repository
git clone https://github.com/Henley04/SXSEditor-Pad.git
cd SXSEditor-Pad

# Install frontend dependencies
npm install --ignore-scripts

# Build the web frontend
npm run build:web

# Run in development mode (desktop)
npm run dev

# Build for Android
npm run android:build

# Build for iOS (macOS only)
npm run ios:build
```

## Development

```bash
# Start webpack dev server
npm run dev:web

# In another terminal, start Tauri dev
npm run dev

# Run tests
npm test

# Lint
npm run lint
```

## Project Structure

```
SXSEditor-Pad/
├── src/                    # Frontend source code
│   ├── renderer/           # Main window renderer
│   ├── fragmentEditor/     # Fragment editor window
│   ├── audioPreprocess/    # Audio preprocessing
│   ├── inference/          # Model inference pipeline
│   ├── themes/             # Theme system
│   ├── i18n/               # Internationalization
│   ├── icons/              # Icon system
│   ├── main/               # Main process logic
│   └── utils/              # Utilities
├── src-tauri/              # Tauri (Rust) backend
│   ├── src/                # Rust source code
│   └── tauri.conf.json     # Tauri configuration
├── docs/                   # Documentation
├── test/                   # Test suite
├── webpack.config.js       # Webpack configuration
└── package.json            # Project metadata
```

## Model Inference

SXSEditor-Pad uses ONNX Runtime Web for model inference, supporting:

- **WebNN API** - NPU/GPU acceleration on compatible devices
- **WASM** - CPU fallback for universal compatibility
- **DirectML** - GPU acceleration on Windows (desktop mode)

Models are downloaded from [ModelScope](https://modelscope.cn) and cached locally.

## Build & Release

The project uses GitHub Actions for CI/CD:

- **CI** - Lint, test, and web build on every push
- **Build APK** - Build Android APKs for arm64-v8a, armeabi-v7a, and x86_64
- **Release** - Create GitHub releases with APK artifacts when tagging with `v*`

## Roadmap

- [x] Tauri v2 migration
- [x] Touch-friendly UI
- [x] ONNX Runtime Web integration
- [x] Android APK build pipeline
- [ ] iOS IPA build pipeline
- [ ] Performance optimization for mobile NPU
- [ ] In-app model download manager
- [ ] Cloud sync for projects

## License

[MIT](LICENSE)

## Links

- [Original SXSEditor](https://github.com/Henley04/SXSEditor)
- [GitHub Issues](https://github.com/Henley04/SXSEditor-Pad/issues)
- [SXSEditor Website](https://henley04.github.io/SXSEditor/)
- [User Docs](https://henley04.github.io/SXSEditor/user/quick-start.html)