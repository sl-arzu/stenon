//! stenon-core: logica headless di Stenon (dettatura vocale locale).
//!
//! Moduli:
//! - [`asr`]: trait `Transcriber` e implementazione Whisper (feature `whisper`)
//! - [`audio`]: cattura audio dal microfono (cpal)
//! - [`config`]: configurazione applicativa (config.toml)
//! - [`pipeline`]: salvataggio delle dettature come note
//! - [`storage`]: persistenza SQLite (note, tracce, segmenti, versioni)

pub mod asr;
pub mod audio;
pub mod config;
pub mod pipeline;
pub mod storage;
