use crate::models::SvMessage;
use crate::goose::ParseError;

pub const SV_ETHERTYPE: u16 = 0x88BA;

struct BerReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> BerReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.pos)
    }

    fn read_byte(&mut self) -> Result<u8, ParseError> {
        if self.pos >= self.data.len() {
            return Err(ParseError::BufferTooShort {
                needed: self.pos + 1,
                available: self.data.len(),
            });
        }
        let b = self.data[self.pos];
        self.pos += 1;
        Ok(b)
    }

    fn read_bytes(&mut self, n: usize) -> Result<&'a [u8], ParseError> {
        if self.pos + n > self.data.len() {
            return Err(ParseError::BufferTooShort {
                needed: self.pos + n,
                available: self.data.len(),
            });
        }
        let slice = &self.data[self.pos..self.pos + n];
        self.pos += n;
        Ok(slice)
    }

    fn read_length(&mut self) -> Result<usize, ParseError> {
        let first = self.read_byte()?;
        if first < 0x80 {
            Ok(first as usize)
        } else {
            let num_bytes = (first & 0x7F) as usize;
            if num_bytes == 0 || num_bytes > 4 {
                return Err(ParseError::BerDecode(format!(
                    "unsupported length encoding: {num_bytes} bytes"
                )));
            }
            let bytes = self.read_bytes(num_bytes)?;
            let mut len: usize = 0;
            for &b in bytes {
                len = (len << 8) | (b as usize);
            }
            Ok(len)
        }
    }

    fn read_tag(&mut self) -> Result<(u8, usize, &'a [u8]), ParseError> {
        let tag = self.read_byte()?;
        let length = self.read_length()?;
        let value = self.read_bytes(length)?;
        Ok((tag, length, value))
    }

    fn read_optional_tag(&mut self, expected_tag: u8) -> Result<Option<&'a [u8]>, ParseError> {
        if self.remaining() == 0 {
            return Ok(None);
        }
        if self.data[self.pos] == expected_tag {
            let (tag, _, value) = self.read_tag()?;
            debug_assert_eq!(tag, expected_tag);
            Ok(Some(value))
        } else {
            Ok(None)
        }
    }
}

const RATED_VOLTAGE_SECONDARY: f64 = 100.0;
const RATED_CURRENT_SECONDARY: f64 = 1.0;
const SCALE_FACTOR_16BIT: f64 = 32768.0;

fn parse_int16_samples(data: &[u8]) -> Vec<f64> {
    let mut results = Vec::new();
    let mut i = 0;
    while i + 1 < data.len() {
        let raw = i16::from_be_bytes([data[i], data[i + 1]]);
        results.push(raw as f64);
        i += 2;
    }
    results
}

fn convert_voltage_samples(raw: &[f64]) -> Vec<f64> {
    raw.iter()
        .map(|&v| v / SCALE_FACTOR_16BIT * RATED_VOLTAGE_SECONDARY)
        .collect()
}

fn convert_current_samples(raw: &[f64]) -> Vec<f64> {
    raw.iter()
        .map(|&v| v / SCALE_FACTOR_16BIT * RATED_CURRENT_SECONDARY)
        .collect()
}

pub fn parse_sv(frame: &[u8]) -> Result<SvMessage, ParseError> {
    if frame.len() < 14 {
        return Err(ParseError::BufferTooShort {
            needed: 14,
            available: frame.len(),
        });
    }

    let mut offset = 12;
    let ether_type = u16::from_be_bytes([frame[offset], frame[offset + 1]]);
    offset += 2;

    if ether_type == 0x8100 {
        if frame.len() < offset + 4 {
            return Err(ParseError::BufferTooShort {
                needed: offset + 4,
                available: frame.len(),
            });
        }
        offset += 4;
        let inner_ether = u16::from_be_bytes([frame[offset], frame[offset + 1]]);
        offset += 2;
        if inner_ether != SV_ETHERTYPE {
            return Err(ParseError::InvalidEtherType(inner_ether));
        }
    } else if ether_type != SV_ETHERTYPE {
        return Err(ParseError::InvalidEtherType(ether_type));
    }

    if frame.len() < offset + 8 {
        return Err(ParseError::BufferTooShort {
            needed: offset + 8,
            available: frame.len(),
        });
    }

    let _appid = u16::from_be_bytes([frame[offset], frame[offset + 1]]);
    let _length = u16::from_be_bytes([frame[offset + 2], frame[offset + 3]]);
    offset += 8;

    let pdu_data = &frame[offset..];
    let mut reader = BerReader::new(pdu_data);

    let (seq_tag, _, seq_data) = reader.read_tag()?;
    if seq_tag != 0x30 {
        return Err(ParseError::BerDecode(format!(
            "expected SEQUENCE tag 0x30, got 0x{seq_tag:02X}"
        )));
    }

    let mut pdu = BerReader::new(seq_data);

    let mut smp_cnt: u16 = 0;
    let mut smp_mod: u8 = 0;
    let mut smp_rate: u32 = 0;
    let mut seq_data_raw: Vec<u8> = Vec::new();
    let mut timestamp: u64 = 0;

    while pdu.remaining() > 0 {
        let current_pos = pdu.pos;
        if current_pos >= pdu.data.len() {
            break;
        }
        let tag = pdu.data[current_pos];

        match tag {
            0x85 => {
                if let Some(v) = pdu.read_optional_tag(0x85)? {
                    let mut val: u16 = 0;
                    for &b in v {
                        val = (val << 8) | (b as u16);
                    }
                    smp_cnt = val;
                }
            }
            0x06 => {
                if let Some(v) = pdu.read_optional_tag(0x06)? {
                    if !v.is_empty() {
                        smp_mod = v[0];
                    }
                }
            }
            0x07 => {
                if let Some(v) = pdu.read_optional_tag(0x07)? {
                    let mut val: u32 = 0;
                    for &b in v {
                        val = (val << 8) | (b as u32);
                    }
                    smp_rate = val;
                }
            }
            0x87 => {
                if let Some(v) = pdu.read_optional_tag(0x87)? {
                    seq_data_raw = v.to_vec();
                }
            }
            0x89 => {
                if let Some(v) = pdu.read_optional_tag(0x89)? {
                    if v.len() >= 8 {
                        let secs = u32::from_be_bytes([v[0], v[1], v[2], v[3]]) as u64;
                        let frac = u32::from_be_bytes([v[4], v[5], v[6], v[7]]) as u64;
                        timestamp = secs * 1_000 + frac / 1_000_000;
                    }
                }
            }
            _ => {
                pdu.read_tag()?;
            }
        }
    }

    let raw_samples = parse_int16_samples(&seq_data_raw);

    let num_channels = raw_samples.len();
    let half = (num_channels + 1) / 2;

    let voltage_raw: Vec<f64> = raw_samples[..half.min(raw_samples.len())].to_vec();
    let current_raw: Vec<f64> = if raw_samples.len() > half {
        raw_samples[half..].to_vec()
    } else {
        Vec::new()
    };

    let voltage_channels = convert_voltage_samples(&voltage_raw);
    let current_channels = convert_current_samples(&current_raw);

    Ok(SvMessage {
        smp_cnt,
        smp_mod,
        smp_rate,
        voltage_channels,
        current_channels,
        timestamp,
    })
}
