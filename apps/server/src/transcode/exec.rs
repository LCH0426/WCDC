use std::ffi::OsString;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

/// Output of a short-lived detection process.
pub struct CmdOutput {
    pub success: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl CmdOutput {
    /// Most detection commands print their useful output to stdout, but some
    /// wrappers (notably PowerShell on older Windows builds) use stderr.
    pub fn text(&self) -> &str {
        if self.stdout.trim().is_empty() {
            &self.stderr
        } else {
            &self.stdout
        }
    }

    pub fn error_tail(&self) -> String {
        error_line(if self.stderr.trim().is_empty() {
            &self.stdout
        } else {
            &self.stderr
        })
        .unwrap_or_else(|| match self.code {
            Some(code) => format!("退出码 {code}"),
            None => "进程异常退出".to_string(),
        })
    }
}

/// Pick the most useful error line from a process log.
pub fn error_line(text: &str) -> Option<String> {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let picked = lines
        .iter()
        .copied()
        .find(|line| {
            let lower = line.to_ascii_lowercase();
            lower.contains("error")
                || lower.contains("fail")
                || lower.contains("cannot")
                || lower.contains("unable")
                || lower.contains("not found")
                || lower.contains("invalid")
        })
        .or_else(|| lines.first().copied());
    picked.map(|line| line.chars().take(500).collect())
}

/// Hide console windows for child processes on Windows.
pub fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.as_std_mut().creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

pub async fn run(program: &Path, args: &[&str], timeout: Duration) -> Result<CmdOutput, String> {
    let args: Vec<OsString> = args.iter().map(OsString::from).collect();
    run_os(program, &args, timeout).await
}

/// Run a detection command with a hard timeout. Never goes through a shell.
pub async fn run_os(
    program: &Path,
    args: &[OsString],
    timeout: Duration,
) -> Result<CmdOutput, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    hide_console(&mut command);

    let output = tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| {
            format!(
                "执行 {} 超时（{} 秒）",
                program.display(),
                timeout.as_secs()
            )
        })?
        .map_err(|error| format!("无法执行 {}: {error}", program.display()))?;

    Ok(CmdOutput {
        success: output.status.success(),
        code: output.status.code(),
        stdout: cap(String::from_utf8_lossy(&output.stdout).into_owned()),
        stderr: cap(String::from_utf8_lossy(&output.stderr).into_owned()),
    })
}

fn cap(value: String) -> String {
    const MAX_CHARS: usize = 256 * 1024;
    if value.chars().count() <= MAX_CHARS {
        value
    } else {
        value.chars().take(MAX_CHARS).collect()
    }
}
