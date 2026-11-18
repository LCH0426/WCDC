use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use sysinfo::{Networks, System};

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub cpu_usage_percent: f32,
    pub cpu_cores: usize,
    pub cpu_brand: String,
    pub memory_total_bytes: u64,
    pub memory_used_bytes: u64,
    pub memory_available_bytes: u64,
    pub network_received_bps: f64,
    pub network_transmitted_bps: f64,
    pub network_total_received_bytes: u64,
    pub network_total_transmitted_bytes: u64,
    pub uptime_seconds: u64,
    pub os_name: String,
    pub os_version: String,
    pub host_name: String,
}

#[derive(Clone)]
pub struct MetricsService {
    inner: Arc<Mutex<ServerInfo>>,
}

impl MetricsService {
    /// Samples CPU, memory and network rates once per second in a background
    /// task. The first snapshot is available after about one second.
    pub fn start() -> Self {
        let inner = Arc::new(Mutex::new(ServerInfo::default()));
        let shared = Arc::clone(&inner);
        tokio::spawn(async move {
            let mut system = System::new_all();
            let mut networks = Networks::new_with_refreshed_list();
            system.refresh_cpu_usage();
            system.refresh_memory();
            let mut last_at = Instant::now();
            let mut last_rx = total_received(&networks);
            let mut last_tx = total_transmitted(&networks);
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                system.refresh_cpu_usage();
                system.refresh_memory();
                networks.refresh(true);
                let rx = total_received(&networks);
                let tx = total_transmitted(&networks);
                let elapsed = last_at.elapsed().as_secs_f64().max(0.1);
                let snapshot = ServerInfo {
                    cpu_usage_percent: system.global_cpu_usage(),
                    cpu_cores: system.cpus().len(),
                    cpu_brand: system
                        .cpus()
                        .first()
                        .map(|cpu| cpu.brand().trim().to_string())
                        .unwrap_or_default(),
                    memory_total_bytes: system.total_memory(),
                    memory_used_bytes: system.used_memory(),
                    memory_available_bytes: system.available_memory(),
                    network_received_bps: rx.saturating_sub(last_rx) as f64 / elapsed,
                    network_transmitted_bps: tx.saturating_sub(last_tx) as f64 / elapsed,
                    network_total_received_bytes: rx,
                    network_total_transmitted_bytes: tx,
                    uptime_seconds: System::uptime(),
                    os_name: System::name().unwrap_or_default(),
                    os_version: System::os_version().unwrap_or_default(),
                    host_name: System::host_name().unwrap_or_default(),
                };
                if let Ok(mut guard) = shared.lock() {
                    *guard = snapshot;
                }
                last_at = Instant::now();
                last_rx = rx;
                last_tx = tx;
            }
        });
        Self { inner }
    }

    pub fn snapshot(&self) -> ServerInfo {
        self.inner
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }
}

fn total_received(networks: &Networks) -> u64 {
    networks
        .values()
        .map(|network| network.total_received())
        .sum()
}

fn total_transmitted(networks: &Networks) -> u64 {
    networks
        .values()
        .map(|network| network.total_transmitted())
        .sum()
}
