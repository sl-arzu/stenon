//! Cattura audio dal dispositivo di input di default (cpal).

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::{Arc, Mutex};

/// Cattura in corso dal microfono di default.
pub struct Capture {
    stream: cpal::Stream,
    buffer: Arc<Mutex<Vec<f32>>>,
    input_rate: u32,
    channels: usize,
}

impl Capture {
    /// Frequenza di campionamento del dispositivo di input.
    pub fn input_rate(&self) -> u32 {
        self.input_rate
    }

    /// Numero di canali del dispositivo di input.
    pub fn channels(&self) -> usize {
        self.channels
    }

    /// Ferma la cattura e restituisce (pcm, rate, canali).
    pub fn stop(self) -> (Vec<f32>, u32, usize) {
        drop(self.stream);
        let data = match Arc::try_unwrap(self.buffer) {
            Ok(m) => m.into_inner().unwrap_or_default(),
            Err(arc) => arc.lock().map(|b| b.clone()).unwrap_or_default(),
        };
        (data, self.input_rate, self.channels)
    }
}

/// Avvia la cattura dal dispositivo di input di default.
pub fn start_capture() -> Result<Capture, String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "nessun dispositivo di input disponibile".to_string())?;
    let cfg = device.default_input_config().map_err(|e| e.to_string())?;
    let (rate, channels) = (cfg.sample_rate().0, cfg.channels() as usize);
    let sample_format = cfg.sample_format();

    let config: cpal::StreamConfig = cfg.into();
    let buffer: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
    let err_fn = |err: cpal::StreamError| eprintln!("stenon: errore cattura: {err}");

    let stream = match sample_format {
        cpal::SampleFormat::F32 => {
            let buf = buffer.clone();
            device.build_input_stream(
                &config,
                move |data: &[f32], _| buf.lock().unwrap().extend(data.iter().copied()),
                err_fn,
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let buf = buffer.clone();
            device.build_input_stream(
                &config,
                move |data: &[i16], _| {
                    buf.lock()
                        .unwrap()
                        .extend(data.iter().map(|&s| s as f32 / 32768.0));
                },
                err_fn,
                None,
            )
        }
        cpal::SampleFormat::U16 => {
            let buf = buffer.clone();
            device.build_input_stream(
                &config,
                move |data: &[u16], _| {
                    buf.lock()
                        .unwrap()
                        .extend(data.iter().map(|&s| (s as f32 - 32768.0) / 32768.0));
                },
                err_fn,
                None,
            )
        }
        other => return Err(format!("formato campione non supportato: {other:?}")),
    }
    .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;

    Ok(Capture {
        stream,
        buffer,
        input_rate: rate,
        channels,
    })
}

/// Converte un buffer PCM in mono f32 a 16 kHz con resampling lineare.
pub fn to_mono_16k(data: &[f32], rate: u32, channels: usize) -> Vec<f32> {
    let ch = channels.max(1);
    let mono: Vec<f32> = data
        .chunks(ch)
        .map(|c| c.iter().sum::<f32>() / ch as f32)
        .collect();
    if rate == 16_000 {
        return mono;
    }
    let out_len = ((mono.len() as f64) * (16_000.0 / rate as f64)).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f64 * (rate as f64 / 16_000.0);
        let idx = (pos as usize).min(mono.len() - 1);
        let frac = (pos - idx as f64) as f32;
        let s0 = mono[idx];
        let s1 = mono[(idx + 1).min(mono.len() - 1)];
        out.push(s0 + (s1 - s0) * frac);
    }
    out
}
