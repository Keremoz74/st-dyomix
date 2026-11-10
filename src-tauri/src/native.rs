// Native plug-ins (VST3 / Audio Units) for the desktop app.
//
// * `native_scan` lists installed plug-ins from the standard folders. Works in every desktop build.
// * `native_render` / `native_params` run a plug-in. They need the optional `native-plugins` cargo
//   feature (VST3 hosting through the `vst3-host` crate, macOS first, Windows experimental):
//       npm run tauri build -- --features native-plugins
//   The web view sends a track's audio, the plug-in processes it offline, and the result comes back
//   as the track's freeze file (see src/audio/freeze.ts). Audio travels as raw bytes, not JSON.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone, Debug)]
pub struct NativePluginInfo {
    pub name: String,
    pub vendor: String,
    pub path: String,
    pub format: String,
    pub is_instrument: bool,
    pub category: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct NativeParam {
    pub id: u32,
    pub name: String,
    pub value: f64,
    pub display: String,
}

#[derive(Deserialize, Debug)]
pub struct MidiEv {
    pub frame: usize,
    pub status: u8,
    pub d1: u8,
    pub d2: u8,
}

#[derive(Deserialize, Debug)]
pub struct RenderMeta {
    pub path: String,
    pub sample_rate: f64,
    pub channels: usize,
    pub frames: usize,
    pub block: Option<usize>,
    pub params: Vec<(u32, f64)>,
    pub state: Option<String>,
    pub midi: Vec<MidiEv>,
}

/// Standard plug-in folders per platform.
fn plugin_dirs() -> Vec<(PathBuf, &'static str)> {
    let mut dirs: Vec<(PathBuf, &'static str)> = Vec::new();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    {
        dirs.push((PathBuf::from("/Library/Audio/Plug-Ins/VST3"), "VST3"));
        dirs.push((PathBuf::from("/Library/Audio/Plug-Ins/Components"), "AU"));
        if let Some(h) = &home {
            dirs.push((h.join("Library/Audio/Plug-Ins/VST3"), "VST3"));
            dirs.push((h.join("Library/Audio/Plug-Ins/Components"), "AU"));
        }
    }
    #[cfg(target_os = "windows")]
    {
        let common = std::env::var_os("CommonProgramFiles").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\Program Files\\Common Files"));
        dirs.push((common.join("VST3"), "VST3"));
        if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            dirs.push((local.join("Programs\\Common\\VST3"), "VST3"));
        }
    }
    #[cfg(target_os = "linux")]
    {
        dirs.push((PathBuf::from("/usr/lib/vst3"), "VST3"));
        dirs.push((PathBuf::from("/usr/local/lib/vst3"), "VST3"));
        if let Some(h) = &home {
            dirs.push((h.join(".vst3"), "VST3"));
        }
    }
    let _ = &home;
    dirs
}

/// Walks a folder (plug-ins are often grouped in vendor sub-folders) for .vst3 / .component bundles.
fn walk(dir: &Path, format: &str, depth: usize, out: &mut Vec<NativePluginInfo>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
        let want = if format == "AU" { "component" } else { "vst3" };
        if ext == want {
            let name = p.file_stem().and_then(|x| x.to_str()).unwrap_or("Plug-in").to_string();
            // plug-ins in a sub-folder are usually grouped by vendor
            let vendor = if depth > 0 { dir.file_name().and_then(|x| x.to_str()).unwrap_or("").to_string() } else { String::new() };
            let lower = name.to_ascii_lowercase();
            let is_instrument = ["synth", "piano", "keys", "drum", "sampler", "kontakt", "serum", "vital", "dexed", "surge", "organ", "strings", "bass"].iter().any(|k| lower.contains(k));
            out.push(NativePluginInfo { name, vendor, path: p.to_string_lossy().to_string(), format: format.to_string(), is_instrument, category: if is_instrument { "Instrument".into() } else { "Effect".into() } });
        } else if p.is_dir() && depth < 2 {
            walk(&p, format, depth + 1, out);
        }
    }
}

/// Lists installed VST3 (and on macOS, Audio Unit) plug-ins.
#[tauri::command]
pub fn native_scan() -> Vec<NativePluginInfo> {
    let mut out = Vec::new();
    for (dir, format) in plugin_dirs() {
        walk(&dir, format, 0, &mut out);
    }
    #[cfg(feature = "native-plugins")]
    {
        // richer data (real vendor, instrument flag) from the VST3 factory info when hosting is built in
        if let Ok(list) = vst3_host::simple::discover_plugins() {
            for info in list {
                let path = info.path.to_string_lossy().to_string();
                if let Some(e) = out.iter_mut().find(|e| e.path == path) {
                    e.name = info.name.clone();
                    e.vendor = info.vendor.clone();
                    e.is_instrument = info.has_midi_input && info.audio_outputs > 0 && info.category.to_ascii_lowercase().contains("instrument");
                    e.category = info.category.clone();
                }
            }
        }
    }
    out.sort_by(|a, b| a.vendor.cmp(&b.vendor).then(a.name.cmp(&b.name)));
    out.dedup_by(|a, b| a.path == b.path);
    out
}

/// Whether this build can run native plug-ins.
#[tauri::command]
pub fn native_hosting_available() -> bool {
    cfg!(feature = "native-plugins")
}

fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(s).map_err(|e| e.to_string())
}

/// Renders audio through a plug-in. Body: planar f32 (little-endian) input channels.
/// Header `x-meta`: base64 JSON RenderMeta. Response: u32 state length, state bytes, u32 channel count, planar f32 output.
#[tauri::command]
pub async fn native_render(request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> {
    let meta_b64 = request.headers().get("x-meta").ok_or("missing x-meta header")?.to_str().map_err(|e| e.to_string())?;
    let meta: RenderMeta = serde_json::from_slice(&b64_decode(meta_b64)?).map_err(|e| e.to_string())?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected raw audio bytes".into()) };
    let mut input: Vec<Vec<f32>> = Vec::with_capacity(meta.channels);
    for c in 0..meta.channels {
        let start = c * meta.frames * 4;
        let end = start + meta.frames * 4;
        if end > bytes.len() { return Err("audio data is shorter than announced".into()); }
        input.push(bytes[start..end].chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect());
    }
    let (output, state) = render(&meta, &input)?;
    let mut res: Vec<u8> = Vec::with_capacity(8 + state.len() + output.len() * meta.frames * 4);
    res.extend_from_slice(&(state.len() as u32).to_le_bytes());
    res.extend_from_slice(&state);
    res.extend_from_slice(&(output.len() as u32).to_le_bytes());
    for ch in &output {
        for v in ch { res.extend_from_slice(&v.to_le_bytes()); }
    }
    Ok(tauri::ipc::Response::new(res))
}

/// Parameter list (id, name, normalized value, display text) of a plug-in.
#[tauri::command]
pub async fn native_params(path: String, state: Option<String>) -> Result<Vec<NativeParam>, String> {
    params(&path, state.as_deref())
}

#[cfg(not(feature = "native-plugins"))]
fn render(_meta: &RenderMeta, _input: &[Vec<f32>]) -> Result<(Vec<Vec<f32>>, Vec<u8>), String> {
    Err("This build can't run native plug-ins (build with the native-plugins feature)".into())
}
#[cfg(not(feature = "native-plugins"))]
fn params(_path: &str, _state: Option<&str>) -> Result<Vec<NativeParam>, String> {
    Err("This build can't run native plug-ins (build with the native-plugins feature)".into())
}

#[cfg(feature = "native-plugins")]
fn render(meta: &RenderMeta, input: &[Vec<f32>]) -> Result<(Vec<Vec<f32>>, Vec<u8>), String> {
    use vst3_host::{audio::AudioBuffers, midi::MidiChannel, Vst3Host};
    let e2s = |e: vst3_host::Error| e.to_string();
    let block = meta.block.unwrap_or(512).clamp(32, 4096);
    let mut host = Vst3Host::builder()
        .sample_rate(meta.sample_rate)
        .block_size(block)
        .with_process_isolation(true)
        .build()
        .map_err(e2s)?;
    let mut plugin = host.load_plugin(&meta.path).map_err(e2s)?;
    if let Some(s) = &meta.state { plugin.load_state(&b64_decode(s)?).map_err(e2s)?; }
    for (id, v) in &meta.params { plugin.set_parameter(*id, *v).map_err(e2s)?; }
    plugin.start_processing().map_err(e2s)?;
    let in_ch = input.len();
    let mut buffer = AudioBuffers::new(in_ch, 2, block, meta.sample_rate);
    let mut out: Vec<Vec<f32>> = vec![Vec::with_capacity(meta.frames); 2];
    let mut ev = meta.midi.iter().peekable();
    let mut pos = 0;
    while pos < meta.frames {
        let n = block.min(meta.frames - pos);
        for c in 0..in_ch {
            let dst = &mut buffer.inputs[c];
            for i in 0..block { dst[i] = if i < n { input[c][pos + i] } else { 0.0 }; }
        }
        // MIDI for this block (note on; velocity 0 = note off)
        while let Some(m) = ev.peek() {
            if m.frame >= pos + n { break; }
            let vel = if m.status & 0xf0 == 0x80 { 0 } else { m.d2 };
            if m.status & 0xf0 == 0x90 || m.status & 0xf0 == 0x80 { plugin.send_midi_note(m.d1, vel, MidiChannel::Ch1).map_err(e2s)?; }
            ev.next();
        }
        plugin.process_audio(&mut buffer).map_err(e2s)?;
        for c in 0..2 { out[c].extend_from_slice(&buffer.outputs[c][..n]); }
        pos += n;
    }
    plugin.stop_processing().map_err(e2s)?;
    let state = plugin.save_state().map_err(e2s)?;
    Ok((out, state))
}

#[cfg(feature = "native-plugins")]
fn params(path: &str, state: Option<&str>) -> Result<Vec<NativeParam>, String> {
    use vst3_host::Vst3Host;
    let e2s = |e: vst3_host::Error| e.to_string();
    let mut host = Vst3Host::new().map_err(e2s)?;
    let mut plugin = host.load_plugin(path).map_err(e2s)?;
    if let Some(s) = state { plugin.load_state(&b64_decode(s)?).map_err(e2s)?; }
    let list = plugin.get_parameters().map_err(e2s)?;
    Ok(list.into_iter().filter(|p| p.can_automate).map(|p| {
        let display = plugin.format_parameter(p.id, p.value).unwrap_or_default();
        NativeParam { id: p.id, name: p.name.clone(), value: p.value, display }
    }).collect())
}
