mod capture;
mod goose;
mod models;
mod server;
mod sv;

use clap::Parser;
use models::{BreakerStatus, GooseMessage, SubstationEvent, SvMessage};
use rand::Rng;
use std::collections::HashMap;
use std::sync::mpsc;
use tokio::sync::broadcast;

#[derive(Parser, Debug)]
#[command(name = "smartgrid-diag", about = "IEC 61850 Smart Grid Diagnostic Tool")]
struct Args {
    #[arg(long, default_value = "simulate")]
    mode: String,

    #[arg(long, default_value = "9502")]
    port: u16,

    #[arg(long, default_value = "eth0")]
    interface: String,
}

fn main() {
    let args = Args::parse();

    let mode = args.mode.to_lowercase();
    let port = args.port;
    let interface = args.interface.clone();

    eprintln!("IEC 61850 Smart Grid Diagnostic Tool");
    eprintln!("Mode: {mode}, WebSocket port: {port}");

    let (tx_std, rx_std) = mpsc::channel::<SubstationEvent>();
    let (tx_bcast, _) = broadcast::channel::<SubstationEvent>(32768);
    let sim_started = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    match mode.as_str() {
        "capture" => {
            let tx_bcast_clone = tx_bcast.clone();
            std::thread::spawn(move || {
                while let Ok(event) = rx_std.recv() {
                    let _ = tx_bcast_clone.send(event);
                }
            });

            let interface_clone = interface.clone();
            std::thread::spawn(move || {
                capture::start_capture(&interface_clone, tx_std);
            });
        }
        "simulate" => {
            let tx_bcast_clone = tx_bcast.clone();
            let started = sim_started.clone();
            std::thread::spawn(move || {
                while !started.load(std::sync::atomic::Ordering::SeqCst) {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                eprintln!("[sim] started simulator thread");
                run_simulator(tx_bcast_clone);
            });
        }
        _ => {
            eprintln!("Unknown mode: {mode}. Use 'capture' or 'simulate'.");
            std::process::exit(1);
        }
    }

    let rt = tokio::runtime::Runtime::new().expect("failed to create tokio runtime");
    rt.block_on(async move {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let rx = tx_bcast.subscribe();
        sim_started.store(true, std::sync::atomic::Ordering::SeqCst);
        server::run_server(port, rx).await;
    });
}

fn run_simulator(tx: broadcast::Sender<SubstationEvent>) {
    let goose_handle = std::thread::spawn({
        let tx = tx.clone();
        move || {
            simulate_goose(tx);
        }
    });

    simulate_sv(tx);

    let _ = goose_handle.join();
}

fn simulate_goose(tx: broadcast::Sender<SubstationEvent>) {
    let breaker_names = [
        "brk_220_a_sec1",
        "brk_220_a_sec2",
        "brk_220_b_sec1",
        "brk_220_b_sec2",
        "brk_xfmr1_hv",
        "brk_xfmr2_hv",
        "brk_xfmr1_lv",
        "brk_xfmr2_lv",
        "brk_220_coupler",
        "brk_110_coupler",
    ];
    let mut rng = rand::rng();
    let mut st_num: u32 = 1;
    let mut sq_num: u32 = 0;

    loop {
        let delay_secs = rng.random_range(2.0..5.0);
        std::thread::sleep(std::time::Duration::from_secs_f64(delay_secs));

        sq_num += 1;
        if rng.random_bool(0.15) {
            st_num += 1;
            sq_num = 1;
        }

        let mut breaker_statuses = HashMap::new();
        for name in &breaker_names {
            let status = if rng.random_bool(0.7) {
                BreakerStatus::Closed
            } else {
                BreakerStatus::Open
            };
            breaker_statuses.insert(name.to_string(), status);
        }

        let now = chrono::Utc::now().timestamp_millis() as u64;

        let goose = GooseMessage {
            go_id: format!("GO_{st_num}"),
            gocb_ref: format!("LD0/LLN0$GO$goCB{st_num}"),
            st_num,
            sq_num,
            timestamp: now,
            dataset_ref: format!("LD0/LLN0$dsGOOSE{st_num}"),
            breaker_statuses,
        };

        if tx.send(SubstationEvent::Goose(goose)).is_err() {
            break;
        }
    }
}

fn simulate_sv(tx: broadcast::Sender<SubstationEvent>) {
    let sv_rate: u32 = 4000;
    let nominal_freq: f64 = 50.0;
    let rated_voltage: f64 = 100.0;
    let rated_current: f64 = 1.0;
    let samples_per_cycle = (sv_rate as f64 / nominal_freq) as usize;

    let output_fps: f64 = 80.0;
    let emit_every_n = ((sv_rate as f64) / output_fps) as u64;

    let mut smp_cnt: u16 = 0;
    let mut tick = 0u64;
    let mut emit_count = 0u64;

    loop {
        let phase = 2.0 * std::f64::consts::PI * nominal_freq * (smp_cnt as f64) / (sv_rate as f64);

        let v_a = rated_voltage * phase.sin();
        let v_b = rated_voltage * (phase - 2.0 * std::f64::consts::PI / 3.0).sin();
        let v_c = rated_voltage * (phase + 2.0 * std::f64::consts::PI / 3.0).sin();

        let i_a = rated_current * (phase - 0.1).sin();
        let i_b = rated_current * (phase - 0.1 - 2.0 * std::f64::consts::PI / 3.0).sin();
        let i_c = rated_current * (phase - 0.1 + 2.0 * std::f64::consts::PI / 3.0).sin();

        let sv = SvMessage {
            smp_cnt,
            smp_mod: 0,
            smp_rate: sv_rate,
            voltage_channels: vec![v_a, v_b, v_c],
            current_channels: vec![i_a, i_b, i_c],
            timestamp: chrono::Utc::now().timestamp_millis() as u64,
        };

        if tick % emit_every_n == 0 {
            match tx.send(SubstationEvent::Sv(sv)) {
                Ok(_n) => {
                    emit_count += 1;
                    if emit_count % 200 == 0 {
                        eprintln!("[sv_sim] sent {emit_count} SV messages, receivers: {_n}");
                    }
                }
                Err(_) => {
                    eprintln!("[sv_sim] no receivers, stopping SV simulator");
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(
                (1000.0 / output_fps) as u64,
            ));
        }

        smp_cnt = (smp_cnt + 1) % (samples_per_cycle as u16);
        tick += 1;
    }
}
