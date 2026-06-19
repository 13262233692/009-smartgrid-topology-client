use crate::models::SubstationEvent;
use std::sync::mpsc;

#[cfg(feature = "capture")]
use crate::{goose, sv};

#[cfg(feature = "capture")]
pub fn start_capture(interface: &str, tx: mpsc::Sender<SubstationEvent>) {
    let device = match pcap::Device::list() {
        Ok(devices) => devices
            .into_iter()
            .find(|d| d.name == interface)
            .or_else(|| {
                pcap::Device::list()
                    .ok()
                    .and_then(|ds| ds.into_iter().next())
            }),
        Err(_) => None,
    };

    let device = match device {
        Some(d) => d,
        None => {
            eprintln!("[capture] no suitable device found for interface: {interface}");
            return;
        }
    };

    let cap = match pcap::Capture::from_device(device) {
        Ok(c) => c.promisc(true).snaplen(65535).timeout(1000),
        Err(e) => {
            eprintln!("[capture] failed to open device: {e}");
            return;
        }
    };

    let mut cap = match cap.open() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[capture] failed to activate capture: {e}");
            return;
        }
    };

    if let Err(e) = cap.filter("ether proto 0x88B8 or ether proto 0x88BA", true) {
        eprintln!("[capture] failed to set BPF filter: {e}");
        return;
    }

    eprintln!("[capture] listening on interface: {interface}");

    while let Ok(packet) = cap.next_packet() {
        let data = packet.data;

        if data.len() < 14 {
            continue;
        }

        let mut offset = 12;
        let mut ether_type = u16::from_be_bytes([data[offset], data[offset + 1]]);

        if ether_type == 0x8100 && data.len() >= 18 {
            offset = 16;
            ether_type = u16::from_be_bytes([data[offset], data[offset + 1]]);
        }

        let event = match ether_type {
            goose::GOOSE_ETHERTYPE => goose::parse_goose(data)
                .map(SubstationEvent::Goose)
                .map_err(|e| {
                    eprintln!("[capture] GOOSE parse error: {e}");
                    e
                })
                .ok(),
            sv::SV_ETHERTYPE => sv::parse_sv(data)
                .map(SubstationEvent::Sv)
                .map_err(|e| {
                    eprintln!("[capture] SV parse error: {e}");
                    e
                })
                .ok(),
            _ => None,
        };

        if let Some(ev) = event {
            if tx.send(ev).is_err() {
                eprintln!("[capture] receiver dropped, stopping capture");
                break;
            }
        }
    }

    eprintln!("[capture] capture loop ended");
}

#[cfg(not(feature = "capture"))]
pub fn start_capture(_interface: &str, _tx: mpsc::Sender<SubstationEvent>) {
    eprintln!("[capture] capture mode not available: compiled without 'capture' feature");
    eprintln!("[capture] rebuild with --features capture to enable live packet capture");
}
