use crate::models::{GooseMessage, SubstationEvent, SvMessage};
use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

pub const DEFAULT_GOOSE_WINDOW_MS: u64 = 20;
pub const DEFAULT_SV_EMIT_HZ: u64 = 80;
pub const DEFAULT_SV_AGG_WINDOW: usize = 8;

pub struct AggregatedGoose {
    pub message: GooseMessage,
    pub deduplicated_count: u64,
}

pub struct AggregatedSv {
    pub sample_count: u64,
    pub smp_cnt_range: (u16, u16),
    pub voltage: Vec<Vec<f64>>,
    pub current: Vec<Vec<f64>>,
    pub timestamps: Vec<u64>,
}

pub enum AggregatedEvent {
    Goose(AggregatedGoose),
    Sv(SvMessage),
    StormWarning { goose_rate: f64, sv_rate: f64 },
}

struct GooseWindow {
    latest: GooseMessage,
    count: u64,
    last_flush: Instant,
}

struct SvAggregator {
    voltage_buffers: Vec<Vec<f64>>,
    current_buffers: Vec<Vec<f64>>,
    timestamps: Vec<u64>,
    smp_start: u16,
    smp_end: u16,
    count: u64,
    window_size: usize,
    emit_interval: Duration,
    last_emit: Instant,
}

impl SvAggregator {
    fn new(num_channels: usize, window_size: usize, emit_hz: u64) -> Self {
        Self {
            voltage_buffers: vec![Vec::with_capacity(window_size * 4); num_channels.min(4)],
            current_buffers: vec![Vec::with_capacity(window_size * 4); num_channels.min(4)],
            timestamps: Vec::with_capacity(window_size * 4),
            smp_start: 0,
            smp_end: 0,
            count: 0,
            window_size,
            emit_interval: Duration::from_micros(1_000_000 / emit_hz),
            last_emit: Instant::now(),
        }
    }

    fn push(&mut self, sv: &SvMessage) -> Option<SvMessage> {
        if self.count == 0 {
            self.smp_start = sv.smp_cnt;
        }
        self.smp_end = sv.smp_cnt;
        self.count += 1;

        for (i, ch) in sv.voltage_channels.iter().enumerate() {
            if i < self.voltage_buffers.len() {
                self.voltage_buffers[i].push(*ch);
            }
        }
        for (i, ch) in sv.current_channels.iter().enumerate() {
            if i < self.current_buffers.len() {
                self.current_buffers[i].push(*ch);
            }
        }
        self.timestamps.push(sv.timestamp);

        let should_emit = self.count >= self.window_size as u64
            || self.last_emit.elapsed() >= self.emit_interval;

        if should_emit && self.count > 0 {
            let num_channels = self.voltage_buffers.len().max(self.current_buffers.len());
            let step = (self.timestamps.len() / num_channels.max(1)).max(1);

            let mut voltage: Vec<f64> = Vec::with_capacity(num_channels);
            for buf in &self.voltage_buffers {
                if !buf.is_empty() {
                    let idx = (buf.len() - 1).min(buf.len() - 1);
                    voltage.push(buf[idx]);
                }
            }
            let mut current: Vec<f64> = Vec::with_capacity(num_channels);
            for buf in &self.current_buffers {
                if !buf.is_empty() {
                    let idx = (buf.len() - 1).min(buf.len() - 1);
                    current.push(buf[idx]);
                }
            }

            let last_ts = *self.timestamps.last().unwrap_or(&0);
            let last_smp = self.smp_end;

            for buf in &mut self.voltage_buffers {
                buf.clear();
            }
            for buf in &mut self.current_buffers {
                buf.clear();
            }
            self.timestamps.clear();
            let count = self.count;
            self.count = 0;
            self.last_emit = Instant::now();
            let _ = step;

            Some(SvMessage {
                smp_cnt: last_smp,
                smp_mod: 0,
                smp_rate: count as u32,
                voltage_channels: voltage,
                current_channels: current,
                timestamp: last_ts,
            })
        } else {
            None
        }
    }
}

struct RateMeter {
    goose_window: Vec<Instant>,
    sv_window: Vec<Instant>,
    last_check: Instant,
}

impl RateMeter {
    fn new() -> Self {
        Self {
            goose_window: Vec::new(),
            sv_window: Vec::new(),
            last_check: Instant::now(),
        }
    }

    fn record_goose(&mut self) {
        self.goose_window.push(Instant::now());
    }
    fn record_sv(&mut self) {
        self.sv_window.push(Instant::now());
    }

    fn get_rates(&mut self) -> (f64, f64) {
        let cutoff = Instant::now() - Duration::from_secs(1);
        self.goose_window.retain(|t| *t > cutoff);
        self.sv_window.retain(|t| *t > cutoff);
        (
            self.goose_window.len() as f64,
            self.sv_window.len() as f64,
        )
    }

    fn should_warn(&mut self, goose_threshold: f64, sv_threshold: f64) -> bool {
        if self.last_check.elapsed() < Duration::from_millis(500) {
            return false;
        }
        self.last_check = Instant::now();
        let (g, s) = self.get_rates();
        g > goose_threshold || s > sv_threshold
    }
}

pub struct EventAggregator {
    goose_windows: HashMap<String, GooseWindow>,
    goose_window_ms: u64,
    sv_agg: SvAggregator,
    rate_meter: RateMeter,
    last_storm_warn: Instant,
    storm_goose_threshold: f64,
    storm_sv_threshold: f64,
    total_dropped_goose: u64,
    total_dropped_sv: u64,
}

impl EventAggregator {
    pub fn new(goose_window_ms: u64, sv_emit_hz: u64, sv_window: usize) -> Self {
        Self {
            goose_windows: HashMap::new(),
            goose_window_ms,
            sv_agg: SvAggregator::new(4, sv_window, sv_emit_hz),
            rate_meter: RateMeter::new(),
            last_storm_warn: Instant::now() - Duration::from_secs(10),
            storm_goose_threshold: 200.0,
            storm_sv_threshold: 2000.0,
            total_dropped_goose: 0,
            total_dropped_sv: 0,
        }
    }

    pub fn process(&mut self, event: SubstationEvent) -> Vec<AggregatedEvent> {
        let mut out = Vec::with_capacity(2);

        match event {
            SubstationEvent::Goose(goose) => {
                self.rate_meter.record_goose();

                let key = goose.gocb_ref.clone();
                let now = Instant::now();
                let win_dur = Duration::from_millis(self.goose_window_ms);

                if let Some(existing) = self.goose_windows.get_mut(&key) {
                    let status_changed = existing.latest.breaker_statuses != goose.breaker_statuses
                        || existing.latest.st_num != goose.st_num;

                    if status_changed || now.duration_since(existing.last_flush) >= win_dur {
                        let flush = std::mem::replace(
                            existing,
                            GooseWindow {
                                latest: goose.clone(),
                                count: 1,
                                last_flush: now,
                            },
                        );
                        out.push(AggregatedEvent::Goose(AggregatedGoose {
                            message: flush.latest,
                            deduplicated_count: flush.count,
                        }));
                    } else {
                        existing.count += 1;
                        existing.latest = goose;
                        self.total_dropped_goose += 1;
                    }
                } else {
                    self.goose_windows.insert(
                        key,
                        GooseWindow {
                            latest: goose.clone(),
                            count: 1,
                            last_flush: now,
                        },
                    );
                    out.push(AggregatedEvent::Goose(AggregatedGoose {
                        message: goose,
                        deduplicated_count: 1,
                    }));
                }

                self.flush_expired_goose_windows(&mut out);
            }
            SubstationEvent::Sv(sv) => {
                self.rate_meter.record_sv();
                if let Some(emitted) = self.sv_agg.push(&sv) {
                    out.push(AggregatedEvent::Sv(emitted));
                } else {
                    self.total_dropped_sv += 1;
                }
            }
        }

        if self.rate_meter.should_warn(self.storm_goose_threshold, self.storm_sv_threshold)
            && self.last_storm_warn.elapsed() >= Duration::from_secs(3)
        {
            let (g, s) = self.rate_meter.get_rates();
            out.push(AggregatedEvent::StormWarning {
                goose_rate: g,
                sv_rate: s,
            });
            self.last_storm_warn = Instant::now();
        }

        out
    }

    fn flush_expired_goose_windows(&mut self, out: &mut Vec<AggregatedEvent>) {
        let win_dur = Duration::from_millis(self.goose_window_ms);
        let now = Instant::now();

        let mut expired: Vec<String> = Vec::new();
        for (key, win) in self.goose_windows.iter_mut() {
            if win.count > 0 && now.duration_since(win.last_flush) >= win_dur {
                let msg = win.latest.clone();
                let cnt = win.count;
                win.count = 0;
                win.last_flush = now;
                out.push(AggregatedEvent::Goose(AggregatedGoose {
                    message: msg,
                    deduplicated_count: cnt,
                }));
                if cnt == 0 {
                    expired.push(key.clone());
                }
            }
        }
        for k in expired {
            self.goose_windows.remove(&k);
        }
    }

    pub fn flush_all(&mut self) -> Vec<AggregatedEvent> {
        let mut out = Vec::new();
        let mut keys: Vec<String> = self.goose_windows.keys().cloned().collect();
        for key in keys.drain(..) {
            if let Some(win) = self.goose_windows.remove(&key) {
                if win.count > 0 {
                    out.push(AggregatedEvent::Goose(AggregatedGoose {
                        message: win.latest,
                        deduplicated_count: win.count,
                    }));
                }
            }
        }
        out
    }

    pub fn get_stats(&self) -> (u64, u64, f64, f64) {
        let g = self.rate_meter.goose_window.len() as f64;
        let s = self.rate_meter.sv_window.len() as f64;
        (self.total_dropped_goose, self.total_dropped_sv, g, s)
    }
}

pub fn spawn_aggregator_thread(
    rx: mpsc::Receiver<SubstationEvent>,
    tx_bcast: broadcast::Sender<AggregatedEvent>,
    goose_window_ms: u64,
    sv_emit_hz: u64,
    sv_window: usize,
) -> Arc<Mutex<EventAggregator>> {
    let aggregator = Arc::new(Mutex::new(EventAggregator::new(
        goose_window_ms,
        sv_emit_hz,
        sv_window,
    )));
    let agg_clone = aggregator.clone();

    std::thread::spawn(move || {
        let agg = agg_clone;
        let flush_interval = Duration::from_millis(goose_window_ms.max(5));
        let mut last_flush = Instant::now();

        loop {
            match rx.recv_timeout(flush_interval) {
                Ok(event) => {
                    let events = if let Ok(mut a) = agg.lock() {
                        a.process(event)
                    } else {
                        vec![]
                    };
                    for ev in events {
                        let _ = tx_bcast.send(ev);
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if last_flush.elapsed() >= flush_interval {
                        if let Ok(mut a) = agg.lock() {
                            let evs = a.flush_all();
                            for ev in evs {
                                let _ = tx_bcast.send(ev);
                            }
                        }
                        last_flush = Instant::now();
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    break;
                }
            }
        }
    });

    aggregator
}
