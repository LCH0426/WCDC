use serde::{Deserialize, Serialize};

use super::gpu::{self, GpuInfo};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HwImpl {
    pub name: String,
    pub accel: String,
    pub vendor: String,
    pub vendor_label: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodecImpls {
    pub software: Vec<String>,
    pub hardware: Vec<HwImpl>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodecSupport {
    pub codec: String,
    pub label: String,
    pub decode: CodecImpls,
    pub encode: CodecImpls,
}

/// Codecs shown on the transcode page, in display order.
const CODECS: &[(&str, &str)] = &[
    ("h264", "H.264 / AVC"),
    ("hevc", "H.265 / HEVC"),
    ("av1", "AV1"),
    ("vp9", "VP9"),
    ("vp8", "VP8"),
    ("vvc", "H.266 / VVC"),
    ("mpeg2video", "MPEG-2"),
    ("mpeg4", "MPEG-4 Part 2"),
    ("vc1", "VC-1"),
    ("prores", "Apple ProRes"),
    ("h263", "H.263"),
    ("mjpeg", "Motion JPEG"),
    ("theora", "Theora"),
];

pub fn build(encoders: &[String], decoders: &[String], gpus: &[GpuInfo]) -> Vec<CodecSupport> {
    let vaapi_vendor = if gpus.iter().any(|gpu| gpu.vendor == "intel") {
        "intel"
    } else if gpus.iter().any(|gpu| gpu.vendor == "amd") {
        "amd"
    } else {
        "generic"
    };

    CODECS
        .iter()
        .map(|(key, label)| {
            let mut decode = CodecImpls::default();
            for name in decoders {
                if codec_key(name) == Some(*key) {
                    push_impl(&mut decode, name, vaapi_vendor);
                }
            }
            let mut encode = CodecImpls::default();
            for name in encoders {
                if codec_key(name) == Some(*key) {
                    push_impl(&mut encode, name, vaapi_vendor);
                }
            }
            decode.software.sort();
            decode.software.dedup();
            decode.hardware.sort_by(|left, right| left.name.cmp(&right.name));
            decode.hardware.dedup_by(|left, right| left.name == right.name);
            encode.software.sort();
            encode.software.dedup();
            encode.hardware.sort_by(|left, right| left.name.cmp(&right.name));
            encode.hardware.dedup_by(|left, right| left.name == right.name);

            CodecSupport {
                codec: key.to_string(),
                label: label.to_string(),
                decode,
                encode,
            }
        })
        .collect()
}

fn push_impl(target: &mut CodecImpls, name: &str, vaapi_vendor: &str) {
    match hardware_kind(name) {
        Some((accel, vendor)) => {
            let vendor = if vendor == "vaapi" {
                vaapi_vendor
            } else {
                vendor
            };
            target.hardware.push(HwImpl {
                name: name.to_string(),
                accel: accel.to_string(),
                vendor: vendor.to_string(),
                vendor_label: gpu::vendor_label(vendor).to_string(),
            });
        }
        None => target.software.push(name.to_string()),
    }
}

/// Match several FFmpeg codec names to the normalized codec key used by the UI.
fn codec_key(name: &str) -> Option<&'static str> {
    let name = name.to_ascii_lowercase();
    if name.starts_with("libx264") || name.starts_with("h264") {
        Some("h264")
    } else if name.starts_with("libx265") || name.starts_with("hevc") || name.starts_with("h265") {
        Some("hevc")
    } else if name.starts_with("libsvtav1")
        || name.starts_with("libaom-av1")
        || name.starts_with("librav1e")
        || name.starts_with("libdav1d")
        || name.starts_with("av1")
    {
        Some("av1")
    } else if name.starts_with("libvpx-vp9") || name.starts_with("vp9") {
        Some("vp9")
    } else if name == "libvpx" || name.starts_with("vp8") {
        Some("vp8")
    } else if name.starts_with("libvvenc") || name.starts_with("vvc") {
        Some("vvc")
    } else if name.starts_with("mpeg2") {
        Some("mpeg2video")
    } else if name.starts_with("mpeg4") || name.starts_with("msmpeg4") {
        Some("mpeg4")
    } else if name.starts_with("vc1") {
        Some("vc1")
    } else if name.starts_with("prores") {
        Some("prores")
    } else if name.starts_with("h263") {
        Some("h263")
    } else if name.starts_with("mjpeg") {
        Some("mjpeg")
    } else if name == "libtheora" || name.starts_with("theora") {
        Some("theora")
    } else {
        None
    }
}

/// Hardware suffix -> (acceleration key, owning vendor).
pub(super) fn hardware_kind(name: &str) -> Option<(&'static str, &'static str)> {
    let name = name.to_ascii_lowercase();
    if name.ends_with("_vaapi") {
        Some(("vaapi", "vaapi"))
    } else if name.ends_with("_qsv") {
        Some(("qsv", "intel"))
    } else if name.ends_with("_nvenc") {
        Some(("nvenc", "nvidia"))
    } else if name.ends_with("_cuvid") || name.ends_with("_nvdec") {
        Some(("nvdec", "nvidia"))
    } else if name.ends_with("_amf") {
        Some(("amf", "amd"))
    } else if name.ends_with("_videotoolbox") {
        Some(("videotoolbox", "apple"))
    } else if name.ends_with("_mf") {
        Some(("mf", "microsoft"))
    } else if name.ends_with("_d3d11va") {
        Some(("d3d11va", "microsoft"))
    } else if name.ends_with("_d3d12va") {
        Some(("d3d12va", "microsoft"))
    } else if name.ends_with("_dxva2") {
        Some(("dxva2", "microsoft"))
    } else if name.ends_with("_rkmpp") {
        Some(("rkmpp", "arm"))
    } else if name.ends_with("_v4l2m2m") {
        Some(("v4l2m2m", "arm"))
    } else if name.ends_with("_mediacodec") {
        Some(("mediacodec", "android"))
    } else if name.ends_with("_vulkan") {
        Some(("vulkan", "generic"))
    } else if name.ends_with("_opencl") {
        Some(("opencl", "generic"))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_hardware_suffixes() {
        assert_eq!(hardware_kind("h264_nvenc"), Some(("nvenc", "nvidia")));
        assert_eq!(hardware_kind("hevc_vaapi"), Some(("vaapi", "vaapi")));
        assert_eq!(hardware_kind("av1_qsv"), Some(("qsv", "intel")));
        assert_eq!(hardware_kind("hevc_vulkan"), Some(("vulkan", "generic")));
        assert_eq!(hardware_kind("libx264"), None);
    }

    #[test]
    fn groups_codecs() {
        assert_eq!(codec_key("libx264"), Some("h264"));
        assert_eq!(codec_key("h264_cuvid"), Some("h264"));
        assert_eq!(codec_key("libsvtav1"), Some("av1"));
        assert_eq!(codec_key("libvpx-vp9"), Some("vp9"));
        assert_eq!(codec_key("hevc_qsv"), Some("hevc"));
        assert_eq!(codec_key("aac"), None);
    }

    #[test]
    fn builds_support_with_vendor() {
        let encoders = vec!["libx264".to_string(), "h264_nvenc".to_string()];
        let decoders = vec!["h264".to_string(), "h264_cuvid".to_string()];
        let gpus = vec![GpuInfo {
            vendor: "nvidia".to_string(),
            vendor_label: "NVIDIA".to_string(),
            name: "RTX".to_string(),
            driver: None,
            bus: None,
            render_devices: Vec::new(),
        }];
        let codecs = build(&encoders, &decoders, &gpus);
        let h264 = codecs.iter().find(|codec| codec.codec == "h264").unwrap();
        assert_eq!(h264.encode.software, vec!["libx264"]);
        assert_eq!(h264.encode.hardware[0].vendor, "nvidia");
    }
}
