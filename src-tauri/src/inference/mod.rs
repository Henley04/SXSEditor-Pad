//! Native inference subsystem: ONNX Runtime (SVS models), LiteRT (Basic
//! Pitch), WAV export and integrity helpers. See `ort_engine.rs` for the
//! session registry design and `frame.rs` for the IPC tensor codec.

pub mod audio_export;
pub mod frame;
pub mod ort_engine;
pub mod tflite;
