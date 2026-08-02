//! WAV export for synthesized audio (`hound`) + SHA-256 file integrity.
//!
//! The renderer already has a JS WAV encoder (src/audio/wavEncoder.js); this
//! native path avoids holding large sample buffers in the WebView when
//! exporting long renders, and writes straight to the user-picked path.

use serde_json::{json, Value as JsonValue};

/// Encode f32 samples (base64, little-endian, interleaved if multi-channel)
/// to a WAV file. `bits_per_sample`: 16 (PCM i16) or 32 (IEEE float).
pub fn export_wav(
    samples_b64: &str,
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
    path: &str,
) -> Result<JsonValue, String> {
    use base64::Engine;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(samples_b64)
        .map_err(|e| format!("bad samples base64: {e}"))?;
    if raw.len() % 4 != 0 {
        return Err("sample payload is not a multiple of 4 bytes (f32)".into());
    }
    let samples: Vec<f32> = raw
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    write_wav_f32(&samples, sample_rate, channels, bits_per_sample, path)
}

/// Shared encoder so tests can exercise it without base64 plumbing.
pub fn write_wav_f32(
    samples: &[f32],
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
    path: &str,
) -> Result<JsonValue, String> {
    if let Some(parent) = std::path::Path::new(path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    let written = match bits_per_sample {
        16 => {
            let spec = hound::WavSpec {
                channels,
                sample_rate,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };
            let mut w = hound::WavWriter::create(path, spec).map_err(|e| e.to_string())?;
            for s in samples {
                let clamped = s.clamp(-1.0, 1.0);
                let v = (clamped * i16::MAX as f32).round() as i16;
                w.write_sample(v).map_err(|e| e.to_string())?;
            }
            w.finalize().map_err(|e| e.to_string())?;
            samples.len() * 2
        }
        32 => {
            let spec = hound::WavSpec {
                channels,
                sample_rate,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            };
            let mut w = hound::WavWriter::create(path, spec).map_err(|e| e.to_string())?;
            for s in samples {
                w.write_sample(*s).map_err(|e| e.to_string())?;
            }
            w.finalize().map_err(|e| e.to_string())?;
            samples.len() * 4
        }
        other => return Err(format!("unsupported bits_per_sample: {}", other)),
    };
    Ok(json!({
        "path": path,
        "frames": if channels > 0 { samples.len() / channels as usize } else { 0 },
        "sampleRate": sample_rate,
        "channels": channels,
        "bitsPerSample": bits_per_sample,
        "dataBytes": written,
    }))
}

/// SHA-256 hex digest of a file, streamed in 1 MiB chunks (models are large).
pub fn sha256_file(path: &str) -> Result<String, String> {
    use sha2::Digest;
    let mut file = std::fs::File::open(path).map_err(|e| format!("open {}: {}", path, e))?;
    let mut hasher = sha2::Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| e.to_string())?;
    Ok(hex_lower(&hasher.finalize()))
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(name: &str) -> String {
        std::env::temp_dir()
            .join(format!("sxseditor_test_{}_{}", std::process::id(), name))
            .to_string_lossy()
            .to_string()
    }

    #[test]
    fn wav16_roundtrip() {
        let path = tmp_path("out16.wav");
        let samples = vec![0.0f32, 0.5, -0.5, 1.0, -1.0, 2.0]; // 2.0 clamps
        let info = write_wav_f32(&samples, 24000, 1, 16, &path).unwrap();
        assert_eq!(info["dataBytes"], 12);
        let mut r = hound::WavReader::open(&path).unwrap();
        let spec = r.spec();
        assert_eq!(spec.sample_rate, 24000);
        assert_eq!(spec.bits_per_sample, 16);
        let vals: Vec<i16> = r.samples::<i16>().map(|s| s.unwrap()).collect();
        assert_eq!(vals.len(), 6);
        assert_eq!(vals[1], (0.5f32 * i16::MAX as f32).round() as i16);
        assert_eq!(vals[4], -i16::MAX); // -1.0 maps to -32767
        assert_eq!(vals[5], i16::MAX); // clamped
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn wav32_float_roundtrip() {
        let path = tmp_path("out32.wav");
        let samples = vec![0.25f32, -1.5];
        write_wav_f32(&samples, 48000, 2, 32, &path).unwrap();
        let mut r = hound::WavReader::open(&path).unwrap();
        assert_eq!(r.spec().sample_format, hound::SampleFormat::Float);
        let vals: Vec<f32> = r.samples::<f32>().map(|s| s.unwrap()).collect();
        assert_eq!(vals, samples);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn sha256_known_value() {
        let path = tmp_path("hash.bin");
        std::fs::write(&path, b"hello world").unwrap();
        let digest = sha256_file(&path).unwrap();
        assert_eq!(
            digest,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn export_wav_validates_payload() {
        use base64::Engine;
        let bad = base64::engine::general_purpose::STANDARD.encode([1u8, 2, 3]);
        assert!(export_wav(&bad, 24000, 1, 16, "/tmp/x.wav").is_err());
    }
}
