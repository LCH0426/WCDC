use std::path::Path;
use std::time::Duration;

use futures_util::future::join_all;

use super::exec;
use super::probe::TranscodeStatus;

const TESTABLE: &[&str] = &[
    "vaapi",
    "qsv",
    "nvenc",
    "amf",
    "videotoolbox",
    "mf",
    "rkmpp",
];

/// Run a one-frame encode through each usable hardware encoder. This detects
/// drivers that FFmpeg advertises but cannot actually initialize (missing
/// permissions, busy device, broken driver) without touching user media.
pub async fn run(bin: &Path, status: &mut TranscodeStatus) {    let Some(h264) = status
        .codecs
        .iter()
        .find(|codec| codec.codec == "h264")
        .cloned()
    else {
        return;
    };

    let mut targets: Vec<(usize, Vec<String>)> = Vec::new();
    for (index, device) in status.devices.iter().enumerate() {
        if device.verified.is_some()
            || !device.available
            || !TESTABLE.contains(&device.accel.as_str())
        {
            continue;
        }
        let Some(encoder) = h264
            .encode
            .hardware
            .iter()
            .find(|implementation| implementation.accel == device.accel)
        else {
            continue;
        };
        targets.push((
            index,
            test_args(&device.accel, &encoder.name, device.device.as_deref()),
        ));
    }

    if targets.is_empty() {
        for device in &mut status.devices {
            if device.verified.is_none() && device.available && device.note.is_none() {
                device.note = Some("没有可自检的硬件编码器".to_string());
            }
        }
        return;
    }

    let bin = bin.to_path_buf();
    let futures = targets.iter().map(|(_, args)| {
        let bin = bin.clone();
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        async move { exec::run(&bin, &args, Duration::from_secs(20)).await }
    });
    let results = join_all(futures).await;

    for ((index, _), result) in targets.iter().zip(results) {
        let device = &mut status.devices[*index];
        match result {
            Ok(output) if output.success => {
                device.verified = Some(true);
                device.note = Some("1 帧测试编码通过".to_string());
            }
            Ok(output) => {
                device.verified = Some(false);
                device.note = Some(format!("自检失败：{}", output.error_tail()));
            }
            Err(error) => {
                device.verified = Some(false);
                device.note = Some(format!("自检失败：{error}"));
            }
        }
    }

    for device in &mut status.devices {
        if device.verified.is_none()
            && device.available
            && device.note.is_none()
            && !TESTABLE.contains(&device.accel.as_str())
        {
            device.note = Some("解码加速，未执行编码自检".to_string());
        }
    }
}

/// Verify one hardware encoder with a real one-frame encode. This catches
/// hardware that FFmpeg advertises but cannot initialize for a specific codec
/// (for example AV1 QSV/VAAPI on GPUs that only support AV1 decoding).
pub async fn verify_encoder(
    bin: &Path,
    accel: &str,
    encoder: &str,
    device: Option<&str>,
) -> Result<(), String> {
    let args = verify_args(accel, encoder, device);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = exec::run(bin, &args, Duration::from_secs(20)).await?;
    if output.success {
        Ok(())
    } else {
        Err(output.error_tail())
    }
}

fn verify_args(accel: &str, encoder: &str, device: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = ["-hide_banner", "-loglevel", "error"]
        .iter()
        .map(|value| value.to_string())
        .collect();
    if accel == "vaapi" {
        args.push("-vaapi_device".to_string());
        args.push(device.unwrap_or("/dev/dri/renderD128").to_string());
    }
    args.extend(
        [
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=256x256:r=10:d=0.2",
            "-frames:v",
            "1",
        ]
        .iter()
        .map(|value| value.to_string()),
    );
    match accel {
        "vaapi" => args.extend(["-vf", "format=nv12,hwupload"].map(String::from)),
        "qsv" => args.extend(["-vf", "format=nv12"].map(String::from)),
        _ => {}
    }
    args.push("-c:v".to_string());
    args.push(encoder.to_string());
    if encoder.ends_with("_nvenc") {
        args.extend(
            ["-preset", "p5", "-rc", "vbr", "-cq", "25", "-b:v", "0"]
                .map(String::from),
        );
    } else if encoder.ends_with("_qsv") {
        args.extend(["-global_quality", "25"].map(String::from));
    } else if encoder.ends_with("_vaapi") {
        args.extend(["-qp", "25"].map(String::from));
    } else if encoder.ends_with("_amf") {
        args.extend(["-rc", "cqp", "-qp_i", "25", "-qp_p", "25"].map(String::from));
    }
    args.extend(["-an", "-f", "null", "-"].map(String::from));
    args
}

fn test_args(accel: &str, encoder: &str, device: Option<&str>) -> Vec<String> {    let mut args: Vec<String> = ["-hide_banner", "-loglevel", "error"]
        .iter()
        .map(|value| value.to_string())
        .collect();

    if accel == "vaapi" {
        args.push("-vaapi_device".to_string());
        args.push(device.unwrap_or("/dev/dri/renderD128").to_string());
    }

    args.extend(
        [
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=256x256:r=10:d=0.2",
            "-frames:v",
            "1",
        ]
        .iter()
        .map(|value| value.to_string()),
    );

    if accel == "vaapi" {
        args.extend(
            ["-vf", "format=nv12,hwupload"]
                .iter()
                .map(|value| value.to_string()),
        );
    }

    args.extend(
        ["-c:v", encoder, "-f", "null", "-"]
            .iter()
            .map(|value| value.to_string()),
    );
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vaapi_args_set_device() {
        let args = test_args("vaapi", "h264_vaapi", Some("/dev/dri/renderD129"));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-vaapi_device" && pair[1] == "/dev/dri/renderD129"));
        assert!(args.iter().any(|value| value == "format=nv12,hwupload"));
        assert!(args.iter().any(|value| value == "h264_vaapi"));
    }

    #[test]
    fn nvenc_args_have_no_vaapi_flags() {
        let args = test_args("nvenc", "h264_nvenc", None);
        assert!(!args.iter().any(|value| value == "-vaapi_device"));
        assert!(args.iter().any(|value| value == "h264_nvenc"));
    }

    #[test]
    fn verify_args_use_codec_specific_quality_and_pixel_format() {
        let qsv = verify_args("qsv", "av1_qsv", None);
        assert!(qsv.windows(2).any(|pair| pair[0] == "-vf" && pair[1] == "format=nv12"));
        assert!(qsv.windows(2).any(|pair| pair[0] == "-global_quality" && pair[1] == "25"));

        let vaapi = verify_args("vaapi", "av1_vaapi", Some("/dev/dri/renderD128"));
        assert!(vaapi
            .windows(2)
            .any(|pair| pair[0] == "-vaapi_device" && pair[1] == "/dev/dri/renderD128"));
        assert!(vaapi
            .windows(2)
            .any(|pair| pair[0] == "-vf" && pair[1] == "format=nv12,hwupload"));
        assert!(vaapi.windows(2).any(|pair| pair[0] == "-qp" && pair[1] == "25"));
    }
}
