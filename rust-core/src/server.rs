use crate::aggregator::{AggregatedEvent, EventAggregator};
use crate::models::SubstationEvent;
use futures_util::{SinkExt, StreamExt};
use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

const CLIENT_CHANNEL_CAP: usize = 4096;
const GOOSE_AGG_WINDOW_MS: u64 = 15;
const SV_EMIT_HZ: u64 = 60;
const SV_AGG_WINDOW: usize = 12;
const MAX_SEND_PER_TICK: usize = 48;
const TICK_MS: u64 = 8;
const SV_DROP_ON_HIGH: usize = 4;
const SV_DROP_ON_CRITICAL: usize = 16;

#[derive(Clone)]
struct ClientHandle {
    tx: tokio::sync::mpsc::Sender<Message>,
    queue_len: Arc<AtomicU64>,
}

#[derive(serde::Serialize)]
#[serde(tag = "aggType")]
enum AggWire {
    #[serde(rename = "goose")]
    Goose {
        #[serde(flatten)]
        m: crate::models::GooseMessage,
        dedupCount: u64,
    },
    #[serde(rename = "sv")]
    Sv {
        #[serde(flatten)]
        s: crate::models::SvMessage,
    },
    #[serde(rename = "storm")]
    Storm {
        gooseRate: f64,
        svRate: f64,
        timestamp: u64,
    },
}

impl From<AggregatedEvent> for AggWire {
    fn from(ev: AggregatedEvent) -> Self {
        match ev {
            AggregatedEvent::Goose(g) => AggWire::Goose {
                m: g.message,
                dedupCount: g.deduplicated_count,
            },
            AggregatedEvent::Sv(sv) => AggWire::Sv { s: sv },
            AggregatedEvent::StormWarning { goose_rate, sv_rate } => AggWire::Storm {
                gooseRate: goose_rate,
                svRate: sv_rate,
                timestamp: chrono::Utc::now().timestamp_millis() as u64,
            },
        }
    }
}

struct Pipeline {
    agg: EventAggregator,
    queue: VecDeque<(Message, u8)>,
    sv_drop: usize,
    stats_timer: Instant,
    in_g: u64,
    in_s: u64,
    out_g: u64,
    out_s: u64,
}

impl Pipeline {
    fn new() -> Self {
        Self {
            agg: EventAggregator::new(GOOSE_AGG_WINDOW_MS, SV_EMIT_HZ, SV_AGG_WINDOW),
            queue: VecDeque::with_capacity(MAX_SEND_PER_TICK * 4),
            sv_drop: 0,
            stats_timer: Instant::now(),
            in_g: 0,
            in_s: 0,
            out_g: 0,
            out_s: 0,
        }
    }

    fn ingest(&mut self, ev: SubstationEvent) {
        match &ev {
            SubstationEvent::Goose(_) => self.in_g += 1,
            SubstationEvent::Sv(_) => self.in_s += 1,
        }
        for a in self.agg.process(ev) {
            let prio: u8 = match &a {
                AggregatedEvent::StormWarning { .. } => 0,
                AggregatedEvent::Goose(_) => 1,
                AggregatedEvent::Sv(_) => 2,
            };
            if let Ok(json) = serde_json::to_string(&AggWire::from(a)) {
                if self.queue.len() < MAX_SEND_PER_TICK * 6 {
                    self.queue.push_back((Message::Text(json.into()), prio));
                }
            }
        }
        self.maybe_print_stats();
    }

    fn maybe_print_stats(&mut self) {
        if self.stats_timer.elapsed() >= Duration::from_secs(5) {
            let (dg, ds, rg, rs) = self.agg.get_stats();
            eprintln!(
                "[pipeline] in G={} S={} | out G={} S={} | dedup_drop G={} S={} | rates G={:.0}/s S={:.0}/s | queue={}",
                self.in_g, self.in_s, self.out_g, self.out_s, dg, ds, rg, rs, self.queue.len()
            );
            self.stats_timer = Instant::now();
        }
    }

    fn flush_to_clients(&mut self, clients: &mut Vec<ClientHandle>) {
        let mut sent = 0;
        while sent < MAX_SEND_PER_TICK && !self.queue.is_empty() {
            let (msg, _prio) = match self.queue.pop_front() {
                Some(v) => v,
                None => break,
            };
            let is_sv = match &msg {
                Message::Text(t) => t.contains("\"aggType\":\"sv\""),
                _ => false,
            };
            let is_goose = match &msg {
                Message::Text(t) => t.contains("\"aggType\":\"goose\"") || t.contains("\"aggType\":\"storm\""),
                _ => false,
            };

            clients.retain(|h| {
                if h.tx.is_closed() { return false; }
                let ql = h.queue_len.load(Ordering::Relaxed);
                let ratio = ql as f64 / CLIENT_CHANNEL_CAP as f64;
                if ratio > 0.9 {
                    if is_sv {
                        self.sv_drop += 1;
                        if self.sv_drop % SV_DROP_ON_CRITICAL != 0 {
                            return true;
                        }
                    } else if ratio > 0.97 && is_goose {
                        return true;
                    }
                } else if ratio > 0.6 && is_sv {
                    self.sv_drop += 1;
                    if self.sv_drop % SV_DROP_ON_HIGH != 0 {
                        return true;
                    }
                }
                match h.tx.try_send(msg.clone()) {
                    Ok(_) => {
                        h.queue_len.fetch_add(1, Ordering::Relaxed);
                        true
                    }
                    Err(_) => false,
                }
            });

            if is_goose { self.out_g += 1; }
            if is_sv { self.out_s += 1; }
            sent += 1;
        }
    }
}

pub async fn run_server(port: u16, mut rx: broadcast::Receiver<SubstationEvent>) {
    let addr: SocketAddr = format!("0.0.0.0:{port}").parse().unwrap();
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => { eprintln!("[server] bind failed: {e}"); return; }
    };
    eprintln!("[server] WebSocket listening on ws://{addr} (aggregated pipeline)");

    let clients: Arc<Mutex<Vec<ClientHandle>>> = Arc::new(Mutex::new(Vec::new()));
    let pipeline: Arc<Mutex<Pipeline>> = Arc::new(Mutex::new(Pipeline::new()));

    let clients_accept = clients.clone();
    let accept = tokio::spawn(async move {
        loop {
            let (stream, peer) = match listener.accept().await {
                Ok(s) => s,
                Err(e) => { eprintln!("[server] accept err: {e}"); continue; }
            };
            let ws_stream = match tokio_tungstenite::accept_async(stream).await {
                Ok(ws) => ws,
                Err(e) => { eprintln!("[server] ws handshake failed {peer}: {e}"); continue; }
            };
            eprintln!("[server] client connected: {peer}");

            let (mut sink, mut stream_rx) = ws_stream.split();
            let (tx, mut rx_ch) = tokio::sync::mpsc::channel::<Message>(CLIENT_CHANNEL_CAP);
            let queue_len = Arc::new(AtomicU64::new(0));
            let ql_dec = queue_len.clone();
            let peer_s = peer.to_string();
            let cl_copy = clients_accept.clone();

            {
                let mut c = clients_accept.lock().await;
                c.push(ClientHandle { tx, queue_len });
                eprintln!("[server] active clients: {}", c.len());
            }

            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        biased;
                        m = stream_rx.next() => {
                            match m {
                                Some(Ok(Message::Close(_))) | Some(Err(_)) => break,
                                _ => {}
                            }
                        }
                        Some(msg) = rx_ch.recv() => {
                            ql_dec.fetch_sub(1, Ordering::Relaxed);
                            if sink.send(msg).await.is_err() { break; }
                        }
                        else => break,
                    }
                }
                let mut c = cl_copy.lock().await;
                let before = c.len();
                c.retain(|h| !h.tx.is_closed());
                let after = c.len();
                eprintln!("[server] client disconnected: {peer_s} ({before}->{after})");
            });
        }
    });

    let clients_bc = clients.clone();
    let pipe_bc = pipeline.clone();
    let broadcast = tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(TICK_MS));
        loop {
            tokio::select! {
                biased;
                res = rx.recv() => {
                    match res {
                        Ok(ev) => {
                            if let Ok(mut p) = pipe_bc.try_lock() {
                                p.ingest(ev);
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            eprintln!("[server] broadcast lagged {n} (continuing via aggregator)");
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
                _ = tick.tick() => {
                    if let (Ok(mut p), Ok(mut cs)) = (pipe_bc.try_lock(), clients_bc.try_lock()) {
                        p.flush_to_clients(&mut cs);
                    }
                }
            }
        }
    });

    let _ = tokio::try_join!(accept, broadcast);
}
