//! Cattura audio di sistema via ScreenCaptureKit (solo macOS).
//!
//! Loopback: tutto l'audio che il Mac sta riproducendo, escluso quello
//! prodotto da Stenon stesso (`excludesCurrentProcessAudio`).
//! Richiede il permesso "Registrazione schermo" anche per audio-only:
//! usiamo `CGPreflightScreenCaptureAccess` per diagnosticarlo onestamente.

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{NSObject, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_core_foundation::CFRetained;
use objc2_core_media::{CMBlockBuffer, CMSampleBuffer};
use objc2_foundation::{NSArray, NSError, NSObjectProtocol};
use objc2_screen_capture_kit::{
    SCContentFilter, SCDisplay, SCShareableContent, SCStream, SCStreamConfiguration,
    SCStreamOutput, SCStreamOutputType, SCWindow,
};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

// Preflight e request del permesso Registrazione schermo (API C CoreGraphics).
// Il preflight NON registra l'app in TCC: senza una request esplicita Stenon
// non compare mai nella lista di Impostazioni › Privacy. La request apre il
// prompt di sistema (una volta sola) e aggiunge l'app alla lista.
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[derive(Debug)]
struct LoopbackIvars {
    buffer: Arc<Mutex<Vec<f32>>>,
}

define_class!(
    // SAFETY: NSObject non ha requisiti di subclassing; la classe non implementa Drop.
    #[unsafe(super(NSObject))]
    #[ivars = LoopbackIvars]
    struct SckAudioOutput;

    impl SckAudioOutput {
        // Protocollo SCStreamOutput: callback su coda interna di SCK.
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        unsafe fn did_output(
            &self,
            _stream: &SCStream,
            sample: &CMSampleBuffer,
            of_type: SCStreamOutputType,
        ) {
            if of_type != SCStreamOutputType::Audio {
                return;
            }
            if let Some(samples) = extract_f32(sample) {
                if let Ok(mut buf) = self.ivars().buffer.lock() {
                    buf.extend_from_slice(&samples);
                }
            }
        }
    }

    unsafe impl NSObjectProtocol for SckAudioOutput {}
    unsafe impl SCStreamOutput for SckAudioOutput {}
);

impl SckAudioOutput {
    fn with_buffer(buffer: Arc<Mutex<Vec<f32>>>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(LoopbackIvars { buffer });
        unsafe { msg_send![super(this), init] }
    }
}

/// Estrae i campioni f32 interleaved da un sample buffer audio.
/// SCK consegna Float32 little-endian nel block buffer.
fn extract_f32(sample: &CMSampleBuffer) -> Option<Vec<f32>> {
    let block: CFRetained<CMBlockBuffer> = unsafe { sample.data_buffer() }?;
    let total = unsafe { block.data_length() };
    if total == 0 || total % 4 != 0 {
        return None;
    }
    let mut len: usize = 0;
    let mut total_out: usize = 0;
    let mut ptr: *mut std::ffi::c_char = std::ptr::null_mut();
    let status = unsafe { block.data_pointer(0, &mut len, &mut total_out, &mut ptr) };
    if status != 0 || ptr.is_null() || total_out == 0 {
        return None;
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr as *const u8, total_out) };
    Some(
        bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
    )
}

/// Cattura loopback in corso.
pub struct LoopbackCapture {
    stream: Retained<SCStream>,
    buffer: Arc<Mutex<Vec<f32>>>,
    rate: u32,
    channels: usize,
}

impl LoopbackCapture {
    /// Frequenza di campionamento del flusso.
    pub fn rate(&self) -> u32 {
        self.rate
    }

    /// Canali del flusso.
    pub fn channels(&self) -> usize {
        self.channels
    }

    /// Copia del buffer accumulato finora, senza fermare la cattura
    /// (usata dal chunking live della riunione, Fase C).
    pub fn snapshot(&self) -> Vec<f32> {
        self.buffer.lock().map(|b| b.clone()).unwrap_or_default()
    }

    /// Ferma la cattura e restituisce (pcm, rate, canali).
    pub fn stop(self) -> (Vec<f32>, u32, usize) {
        unsafe { self.stream.stopCaptureWithCompletionHandler(None) };
        let data = self.buffer.lock().map(|b| b.clone()).unwrap_or_default();
        (data, self.rate, self.channels)
    }
}

/// Avvia la cattura dell'audio di sistema.
/// Err("permission-request") se manca il permesso Registrazione schermo:
/// in tal caso è stato aperto il prompt di sistema che aggiunge Stenon
/// alla lista (Impostazioni › Privacy e sicurezza › Registrazione schermo).
pub fn start_loopback() -> Result<LoopbackCapture, String> {
    // 1. Permesso: preflight; se assente, request (apre il prompt di sistema
    //    e registra l'app in TCC) e uscita con codice riconoscibile.
    unsafe {
        if !CGPreflightScreenCaptureAccess() {
            CGRequestScreenCaptureAccess();
            return Err("permission-request".to_string());
        }
    }

    // 2. Contenuto condivisibile: getShareableContent e' async-only,
    //    lo sincronizziamo con un canale.
    let (tx, rx) = mpsc::channel::<Result<Retained<SCShareableContent>, String>>();
    let block = RcBlock::new(
        move |content: *mut SCShareableContent, error: *mut NSError| {
            if error.is_null() && !content.is_null() {
                let content = unsafe { Retained::retain_autoreleased(content) };
                let _ = tx.send(match content {
                    Some(c) => Ok(c),
                    None => Err("loopback: contenuto nullo".to_string()),
                });
            } else {
                let _ = tx.send(Err("loopback: contenuto non disponibile".to_string()));
            }
        },
    );
    unsafe {
        SCShareableContent::getShareableContentWithCompletionHandler(&block);
    }
    let content = rx
        .recv()
        .map_err(|_| "loopback: callback non ricevuta".to_string())??;

    // 3. Filtro: intero schermo (per l'audio basta; nessun video registrato).
    let display: Retained<SCDisplay> = unsafe { content.displays() }
        .into_iter()
        .next()
        .ok_or_else(|| "loopback: nessun display".to_string())?;
    let windows: Retained<NSArray<SCWindow>> = NSArray::new();
    let filter = unsafe {
        SCContentFilter::initWithDisplay_excludingWindows(
            SCContentFilter::alloc(),
            &display,
            &windows,
        )
    };

    // 4. Configurazione: video al minimo, audio 48 kHz MONO
    //    (SCK downmixa per noi; mono semplifica estrazione e ASR).
    let config: Retained<SCStreamConfiguration> =
        unsafe { msg_send![SCStreamConfiguration::alloc(), init] };
    unsafe {
        config.setWidth(2);
        config.setHeight(2);
        config.setCapturesAudio(true);
        config.setExcludesCurrentProcessAudio(true);
        config.setSampleRate(48_000);
        config.setChannelCount(1);
    }

    // 5. Stream + handler audio.
    let buffer: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
    let output = SckAudioOutput::with_buffer(buffer.clone());
    let stream = unsafe {
        SCStream::initWithFilter_configuration_delegate(SCStream::alloc(), &filter, &config, None)
    };
    unsafe {
        stream
            .addStreamOutput_type_sampleHandlerQueue_error(
                ProtocolObject::from_ref(&*output),
                SCStreamOutputType::Audio,
                None,
            )
            .map_err(|e| format!("loopback: handler: {e}"))?;
        stream.startCaptureWithCompletionHandler(None);
    }

    Ok(LoopbackCapture {
        stream,
        buffer,
        rate: 48_000,
        channels: 1,
    })
}
