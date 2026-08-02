//! Binary tensor frame codec shared with the renderer
//! (`src/inference/native/tensorCodec.js`).
//!
//! Layout (all little-endian):
//! ```text
//! [u32 header_len][header JSON (UTF-8)][blob bytes]
//! ```
//! The header JSON describes every tensor by name, dtype, shape and the
//! byte range (offset/length) of its payload inside the blob. Keeping the
//! header tiny and the payload raw avoids JSON-serializing megabytes of
//! tensor data (which is what a plain `invoke()` would do on Android).
//!
//! Request header:  `{ "v":1, "modelId":"diffStep", "inputs":[TensorMeta...] }`
//! Response header: `{ "v":1, "outputs":[TensorMeta...] }`
//! TensorMeta: `{ "name":String, "dtype":String, "shape":[i64...], "offset":u32, "length":u32 }`

use serde::{Deserialize, Serialize};

pub const FRAME_VERSION: u32 = 1;

/// Element types understood by the codec. Mirrors the dtype strings used by
/// onnxruntime-web (`float32`, `float16`, `int64`, ...) so the renderer can
/// pass its tensor types through unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DType {
    Float32,
    Float16,
    Float64,
    Int8,
    Uint8,
    Int16,
    Uint16,
    Int32,
    Uint32,
    Int64,
    Uint64,
    Bool,
}

impl DType {
    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "float32" => Self::Float32,
            "float16" => Self::Float16,
            "float64" => Self::Float64,
            "int8" => Self::Int8,
            "uint8" => Self::Uint8,
            "int16" => Self::Int16,
            "uint16" => Self::Uint16,
            "int32" => Self::Int32,
            "uint32" => Self::Uint32,
            "int64" => Self::Int64,
            "uint64" => Self::Uint64,
            "bool" => Self::Bool,
            _ => return None,
        })
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Float32 => "float32",
            Self::Float16 => "float16",
            Self::Float64 => "float64",
            Self::Int8 => "int8",
            Self::Uint8 => "uint8",
            Self::Int16 => "int16",
            Self::Uint16 => "uint16",
            Self::Int32 => "int32",
            Self::Uint32 => "uint32",
            Self::Int64 => "int64",
            Self::Uint64 => "uint64",
            Self::Bool => "bool",
        }
    }

    pub fn byte_size(&self) -> usize {
        match self {
            Self::Float32 | Self::Int32 | Self::Uint32 => 4,
            Self::Float16 | Self::Int16 | Self::Uint16 => 2,
            Self::Float64 | Self::Int64 | Self::Uint64 => 8,
            Self::Int8 | Self::Uint8 | Self::Bool => 1,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TensorMeta {
    pub name: String,
    pub dtype: String,
    pub shape: Vec<i64>,
    pub offset: u32,
    pub length: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRequestHeader {
    pub v: u32,
    #[serde(rename = "modelId")]
    pub model_id: String,
    pub inputs: Vec<TensorMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunResponseHeader {
    pub v: u32,
    pub outputs: Vec<TensorMeta>,
}

/// A decoded tensor: metadata plus an owned copy of its payload bytes.
#[derive(Debug, Clone)]
pub struct FrameTensor {
    pub name: String,
    pub dtype: DType,
    pub shape: Vec<i64>,
    pub bytes: Vec<u8>,
}

impl FrameTensor {
    pub fn element_count(&self) -> usize {
        self.shape
            .iter()
            .map(|d| if *d > 0 { *d as usize } else { 0 })
            .product()
    }

    /// Validate that payload length matches dtype × element count.
    pub fn validate(&self) -> Result<(), String> {
        let expected = self.element_count() * self.dtype.byte_size();
        if self.bytes.len() != expected {
            return Err(format!(
                "tensor '{}' payload size mismatch: got {} bytes, expected {} (dtype {} shape {:?})",
                self.name,
                self.bytes.len(),
                expected,
                self.dtype.as_str(),
                self.shape
            ));
        }
        Ok(())
    }
}

/// Split a frame into (header_json_bytes, blob).
pub fn split_frame(frame: &[u8]) -> Result<(&[u8], &[u8]), String> {
    if frame.len() < 4 {
        return Err(format!("frame too small: {} bytes", frame.len()));
    }
    let header_len = u32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
    if frame.len() < 4 + header_len {
        return Err(format!(
            "frame truncated: header_len={} but frame is {} bytes",
            header_len,
            frame.len()
        ));
    }
    Ok((&frame[4..4 + header_len], &frame[4 + header_len..]))
}

/// Decode a run-request frame into the model id and its input tensors.
pub fn decode_run_request(frame: &[u8]) -> Result<(String, Vec<FrameTensor>), String> {
    let (header_bytes, blob) = split_frame(frame)?;
    let header: RunRequestHeader =
        serde_json::from_slice(header_bytes).map_err(|e| format!("bad request header: {e}"))?;
    if header.v != FRAME_VERSION {
        return Err(format!("unsupported frame version {}", header.v));
    }
    let mut tensors = Vec::with_capacity(header.inputs.len());
    for meta in &header.inputs {
        let dtype = DType::from_str(&meta.dtype)
            .ok_or_else(|| format!("unsupported dtype '{}'", meta.dtype))?;
        let start = meta.offset as usize;
        let end = start + meta.length as usize;
        if end > blob.len() {
            return Err(format!(
                "tensor '{}' range [{}, {}) exceeds blob size {}",
                meta.name,
                start,
                end,
                blob.len()
            ));
        }
        let t = FrameTensor {
            name: meta.name.clone(),
            dtype,
            shape: meta.shape.clone(),
            bytes: blob[start..end].to_vec(),
        };
        t.validate()?;
        tensors.push(t);
    }
    Ok((header.model_id, tensors))
}

/// Encode output tensors into a response frame.
pub fn encode_run_response(outputs: &[FrameTensor]) -> Result<Vec<u8>, String> {
    let mut metas = Vec::with_capacity(outputs.len());
    let mut blob = Vec::new();
    for t in outputs {
        t.validate()?;
        let offset = blob.len() as u32;
        blob.extend_from_slice(&t.bytes);
        metas.push(TensorMeta {
            name: t.name.clone(),
            dtype: t.dtype.as_str().to_string(),
            shape: t.shape.clone(),
            offset,
            length: t.bytes.len() as u32,
        });
    }
    let header = RunResponseHeader {
        v: FRAME_VERSION,
        outputs: metas,
    };
    let header_bytes = serde_json::to_vec(&header).map_err(|e| e.to_string())?;
    let mut frame = Vec::with_capacity(4 + header_bytes.len() + blob.len());
    frame.extend_from_slice(&(header_bytes.len() as u32).to_le_bytes());
    frame.extend_from_slice(&header_bytes);
    frame.extend_from_slice(&blob);
    Ok(frame)
}

// ------------------------------ typed conversions ------------------------------
// Little-endian conversions between raw payload bytes and Rust vectors. Kept
// allocation-explicit so the hot path is obvious; counts are validated by
// FrameTensor::validate() before use.

pub fn bytes_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

pub fn f32_to_bytes(data: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() * 4);
    for v in data {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

pub fn bytes_to_f16(bits: &[u8]) -> Vec<half::f16> {
    bits.chunks_exact(2)
        .map(|c| half::f16::from_le_bytes([c[0], c[1]]))
        .collect()
}

pub fn f16_to_bytes(data: &[half::f16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() * 2);
    for v in data {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

pub fn bytes_to_i64(bytes: &[u8]) -> Vec<i64> {
    bytes
        .chunks_exact(8)
        .map(|c| i64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]]))
        .collect()
}

pub fn i64_to_bytes(data: &[i64]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() * 8);
    for v in data {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

pub fn bytes_to_i32(bytes: &[u8]) -> Vec<i32> {
    bytes
        .chunks_exact(4)
        .map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

pub fn i32_to_bytes(data: &[i32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() * 4);
    for v in data {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_outputs() -> Vec<FrameTensor> {
        vec![
            FrameTensor {
                name: "embeddings".into(),
                dtype: DType::Float32,
                shape: vec![1, 2, 2],
                bytes: f32_to_bytes(&[0.5, -1.25, 3.0, 42.0]),
            },
            FrameTensor {
                name: "ids".into(),
                dtype: DType::Int64,
                shape: vec![3],
                bytes: i64_to_bytes(&[7, -8, 9000000000]),
            },
            FrameTensor {
                name: "mel16".into(),
                dtype: DType::Float16,
                shape: vec![2],
                bytes: f16_to_bytes(&[half::f16::from_f32(1.5), half::f16::from_f32(-0.5)]),
            },
        ]
    }

    #[test]
    fn dtype_roundtrip() {
        for s in [
            "float32", "float16", "float64", "int8", "uint8", "int16", "uint16", "int32", "uint32",
            "int64", "uint64", "bool",
        ] {
            let dt = DType::from_str(s).unwrap();
            assert_eq!(dt.as_str(), s);
        }
        assert!(DType::from_str("complex64").is_none());
    }

    #[test]
    fn response_frame_roundtrip() {
        let tensors = sample_outputs();
        let frame = encode_run_response(&tensors).unwrap();
        let (header_bytes, blob) = split_frame(&frame).unwrap();
        let header: RunResponseHeader = serde_json::from_slice(header_bytes).unwrap();
        assert_eq!(header.v, FRAME_VERSION);
        assert_eq!(header.outputs.len(), 3);
        for (meta, orig) in header.outputs.iter().zip(tensors.iter()) {
            assert_eq!(meta.name, orig.name);
            assert_eq!(meta.dtype, orig.dtype.as_str());
            assert_eq!(meta.shape, orig.shape);
            let start = meta.offset as usize;
            let end = start + meta.length as usize;
            assert_eq!(&blob[start..end], &orig.bytes[..]);
        }
    }

    #[test]
    fn request_decode_validates_ranges() {
        // Build a request whose tensor range exceeds the blob.
        let header = RunRequestHeader {
            v: 1,
            model_id: "diffStep".into(),
            inputs: vec![TensorMeta {
                name: "x".into(),
                dtype: "float32".into(),
                shape: vec![4],
                offset: 0,
                length: 999,
            }],
        };
        let hb = serde_json::to_vec(&header).unwrap();
        let mut frame = Vec::new();
        frame.extend_from_slice(&(hb.len() as u32).to_le_bytes());
        frame.extend_from_slice(&hb);
        frame.extend_from_slice(&[0u8; 16]);
        assert!(decode_run_request(&frame).is_err());
    }

    #[test]
    fn request_decode_roundtrip() {
        let tensors = sample_outputs();
        let mut inputs = Vec::new();
        let mut blob = Vec::new();
        for t in &tensors {
            let offset = blob.len() as u32;
            blob.extend_from_slice(&t.bytes);
            inputs.push(TensorMeta {
                name: t.name.clone(),
                dtype: t.dtype.as_str().into(),
                shape: t.shape.clone(),
                offset,
                length: t.bytes.len() as u32,
            });
        }
        let header = RunRequestHeader {
            v: 1,
            model_id: "vocoder".into(),
            inputs,
        };
        let hb = serde_json::to_vec(&header).unwrap();
        let mut frame = Vec::new();
        frame.extend_from_slice(&(hb.len() as u32).to_le_bytes());
        frame.extend_from_slice(&hb);
        frame.extend_from_slice(&blob);

        let (model_id, decoded) = decode_run_request(&frame).unwrap();
        assert_eq!(model_id, "vocoder");
        assert_eq!(decoded.len(), 3);
        assert_eq!(decoded[0].dtype, DType::Float32);
        assert_eq!(decoded[0].bytes, tensors[0].bytes);
        assert_eq!(decoded[1].dtype, DType::Int64);
        assert_eq!(decoded[2].dtype, DType::Float16);
    }

    #[test]
    fn f32_conversion_preserves_values() {
        let vals = [0.0f32, -0.0, 1.5, -2.75, f32::MAX, f32::MIN_POSITIVE];
        let bytes = f32_to_bytes(&vals);
        let back = bytes_to_f32(&bytes);
        assert_eq!(back.len(), vals.len());
        for (a, b) in vals.iter().zip(back.iter()) {
            assert_eq!(a.to_bits(), b.to_bits());
        }
    }

    #[test]
    fn f16_conversion_preserves_values() {
        let vals = [
            half::f16::from_f32(0.0),
            half::f16::from_f32(1.0),
            half::f16::from_f32(-3.5),
            half::f16::INFINITY,
        ];
        let bytes = f16_to_bytes(&vals);
        let back = bytes_to_f16(&bytes);
        assert_eq!(back, vals);
    }

    #[test]
    fn tensor_validation_catches_size_mismatch() {
        let bad = FrameTensor {
            name: "x".into(),
            dtype: DType::Float32,
            shape: vec![2, 2],
            bytes: vec![0u8; 3],
        };
        assert!(bad.validate().is_err());
        let good = FrameTensor {
            name: "x".into(),
            dtype: DType::Int8,
            shape: vec![2, 2],
            bytes: vec![0u8; 4],
        };
        assert!(good.validate().is_ok());
    }
}
