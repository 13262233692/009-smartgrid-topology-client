use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BreakerStatus {
    Open,
    Closed,
    Intermediate,
    Invalid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GooseMessage {
    pub go_id: String,
    pub gocb_ref: String,
    pub st_num: u32,
    pub sq_num: u32,
    pub timestamp: u64,
    pub dataset_ref: String,
    pub breaker_statuses: HashMap<String, BreakerStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SvMessage {
    pub smp_cnt: u16,
    pub smp_mod: u8,
    pub smp_rate: u32,
    pub voltage_channels: Vec<f64>,
    pub current_channels: Vec<f64>,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SubstationEvent {
    Goose(GooseMessage),
    Sv(SvMessage),
}
