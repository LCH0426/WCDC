use std::collections::VecDeque;
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::registry::LookupSpan;

const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRecord {
    pub timestamp: i64,
    pub level: String,
    pub target: String,
    pub message: String,
}

#[derive(Clone)]
pub struct LogBuffer {
    inner: Arc<Mutex<Inner>>,
    capacity: usize,
}

struct Inner {
    entries: VecDeque<LogRecord>,
    file: Option<File>,
}

impl LogBuffer {
    pub fn new(path: PathBuf, capacity: usize) -> Self {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(metadata) = std::fs::metadata(&path) {
            if metadata.len() > MAX_FILE_BYTES {
                let rotated = path.with_extension("log.1");
                let _ = std::fs::rename(&path, rotated);
            }
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok();
        Self {
            inner: Arc::new(Mutex::new(Inner {
                entries: VecDeque::with_capacity(capacity.max(64)),
                file,
            })),
            capacity: capacity.max(64),
        }
    }

    pub fn push(&self, record: LogRecord) {
        let mut inner = self.inner.lock().expect("log buffer poisoned");
        if let Some(file) = inner.file.as_mut() {
            let _ = writeln!(
                file,
                "{} {} {} {}",
                record.timestamp, record.level, record.target, record.message
            );
            let _ = file.flush();
        }
        inner.entries.push_back(record);
        while inner.entries.len() > self.capacity {
            inner.entries.pop_front();
        }
    }

    pub fn list(
        &self,
        limit: usize,
        level: Option<&str>,
        contains: Option<&str>,
    ) -> Vec<LogRecord> {
        let inner = self.inner.lock().expect("log buffer poisoned");
        let level = level.map(|value| value.to_ascii_uppercase());
        let contains = contains.map(|value| value.to_lowercase());
        inner
            .entries
            .iter()
            .rev()
            .filter(|record| {
                level
                    .as_deref()
                    .map(|level| record.level.eq_ignore_ascii_case(level))
                    .unwrap_or(true)
            })
            .filter(|record| {
                contains
                    .as_deref()
                    .map(|needle| {
                        record.message.to_lowercase().contains(needle)
                            || record.target.to_lowercase().contains(needle)
                    })
                    .unwrap_or(true)
            })
            .take(limit.clamp(1, 2000))
            .cloned()
            .collect()
    }

    pub fn len(&self) -> usize {
        self.inner
            .lock()
            .expect("log buffer poisoned")
            .entries
            .len()
    }

    pub fn clear(&self) {
        let mut inner = self.inner.lock().expect("log buffer poisoned");
        inner.entries.clear();
    }
}

pub struct LogLayer {
    buffer: LogBuffer,
}

impl LogLayer {
    pub fn new(buffer: LogBuffer) -> Self {
        Self { buffer }
    }
}

impl<S> Layer<S> for LogLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_event(&self, event: &Event<'_>, _context: Context<'_, S>) {
        let metadata = event.metadata();
        let mut visitor = MessageVisitor::default();
        event.record(&mut visitor);
        let mut message = visitor.message;
        for (key, value) in visitor.fields {
            if !message.is_empty() {
                message.push(' ');
            }
            message.push_str(&format!("{key}={value}"));
        }
        self.buffer.push(LogRecord {
            timestamp: chrono::Utc::now().timestamp_millis(),
            level: metadata.level().to_string(),
            target: metadata.target().to_string(),
            message,
        });
    }
}

#[derive(Default)]
struct MessageVisitor {
    message: String,
    fields: Vec<(String, String)>,
}

impl Visit for MessageVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_string();
        } else {
            self.fields
                .push((field.name().to_string(), value.to_string()));
        }
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        let text = format!("{value:?}");
        if field.name() == "message" {
            self.message = text;
        } else {
            self.fields.push((field.name().to_string(), text));
        }
    }
}
