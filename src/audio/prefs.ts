// Audio device preferences (Settings › Audio), kept per device in localStorage.
export interface AudioPrefs {
  latency: 'interactive' | 'balanced' | 'playback' | number; // AudioContext latencyHint (number = seconds)
  sampleRate: number;        // 0 = device default
  outputId: string;          // '' = system default output (setSinkId)
  bounceRate: number;        // sample rate of bounced WAV files
  bounceBits: 16 | 24 | 32;  // WAV bit depth (32 = float)
  bounceTail: number;        // extra seconds rendered after the song end (reverb/delay tails)
  normalize: boolean;        // bounce: normalize peak to -1 dBFS
}
export const AUDIO_DEFAULTS: AudioPrefs = { latency: 'interactive', sampleRate: 0, outputId: '', bounceRate: 44100, bounceBits: 16, bounceTail: 2, normalize: false };

export function audioPrefs(): AudioPrefs {
  try { return { ...AUDIO_DEFAULTS, ...JSON.parse(localStorage.getItem('daw.audio') || '{}') }; } catch { return { ...AUDIO_DEFAULTS }; }
}
export function saveAudioPrefs(p: Partial<AudioPrefs>) {
  try { localStorage.setItem('daw.audio', JSON.stringify({ ...audioPrefs(), ...p })); } catch { /* storage off */ }
}
