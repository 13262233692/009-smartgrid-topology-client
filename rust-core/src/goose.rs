use crate::models::{BreakerStatus, GooseMessage};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ParseError {
    #[error("buffer too short: need {needed} bytes, got {available}")]
    BufferTooShort { needed: usize, available: usize },
    #[error("invalid EtherType: expected 0x88B8, got 0x{0:04X}")]
    InvalidEtherType(u16),
    #[error("ASN.1 BER decode error: {0}")]
    BerDecode(String),
}

pub const GOOSE_ETHERTYPE: u16 = 0x88B8;

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

fn parse_tstamp(data: &[u8]) -> u64 {
    if data.len() >= 8 {
        let seconds = u32::from_be_bytes([data[0], data[1], data[2], data[3]]) as u64;
        let frac = u32::from_be_bytes([data[4], data[5], data[6], data[7]]) as u64;
        seconds * 1_000 + frac / 1_000_000
    } else {
        0
    }
}

fn parse_goose_alldata(data: &[u8]) -> Result<Vec<bool>, ParseError> {
    let mut reader = BerReader::new(data);
    let mut results = Vec::new();

    while reader.remaining() > 0 {
        let tag = reader.read_byte()?;
        let _len = reader.read_length()?;

        match tag {
            0x83 => {
                results.push(true);
            }
            0x84 => {
                results.push(false);
            }
            0x01 => {
                let val = reader.read_byte()?;
                results.push(val != 0);
            }
            _ => {
                let skip = _len;
                reader.read_bytes(skip)?;
            }
        }
    }

    Ok(results)
}

pub fn parse_goose(frame: &[u8]) -> Result<GooseMessage, ParseError> {
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
        if inner_ether != GOOSE_ETHERTYPE {
            return Err(ParseError::InvalidEtherType(inner_ether));
        }
    } else if ether_type != GOOSE_ETHERTYPE {
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

    let gocb_ref = pdu
        .read_optional_tag(0x80)?
        .map(|v| String::from_utf8_lossy(v).to_string())
        .unwrap_or_default();

    let go_id = pdu
        .read_optional_tag(0x81)?
        .map(|v| String::from_utf8_lossy(v).to_string())
        .unwrap_or_default();

    let dataset_ref = pdu
        .read_optional_tag(0x82)?
        .map(|v| String::from_utf8_lossy(v).to_string())
        .unwrap_or_default();

    let _goose_ref = pdu.read_optional_tag(0x83)?;

    let st_num = pdu
        .read_optional_tag(0x84)?
        .map(|v| {
            let mut val: u32 = 0;
            for &b in v {
                val = (val << 8) | (b as u32);
            }
            val
        })
        .unwrap_or(0);

    let sq_num = pdu
        .read_optional_tag(0x85)?
        .map(|v| {
            let mut val: u32 = 0;
            for &b in v {
                val = (val << 8) | (b as u32);
            }
            val
        })
        .unwrap_or(0);

    let timestamp = pdu
        .read_optional_tag(0x86)?
        .map(|v| parse_tstamp(v))
        .unwrap_or(0);

    let _conf_rev = pdu.read_optional_tag(0x87)?;
    let _nds_com = pdu.read_optional_tag(0x89)?;

    let all_data_bytes = pdu.read_optional_tag(0xAB)?;

    let mut breaker_statuses = std::collections::HashMap::new();
    if let Some(ad) = all_data_bytes {
        let bools = parse_goose_alldata(ad)?;
        for (i, &val) in bools.iter().enumerate() {
            let name = format!("Brk{i}");
            let status = if val {
                BreakerStatus::Closed
            } else {
                BreakerStatus::Open
            };
            breaker_statuses.insert(name, status);
        }
    }

    Ok(GooseMessage {
        go_id,
        gocb_ref,
        st_num,
        sq_num,
        timestamp,
        dataset_ref,
        breaker_statuses,
    })
}
