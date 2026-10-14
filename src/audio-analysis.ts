export type AudioKind = 'missing' | 'silent' | 'captured';

export const EMPTY_TRANSCRIPT_MESSAGE = 'No transcript was recognized. Play the recording to check the audio, then retry or add text.';

/** RMS measures input level; it does not determine whether speech is intelligible. */
export function audioRms(audio: Float32Array): number {
  if (!audio.length) return 0;
  let sum = 0;
  for (const sample of audio) sum += sample * sample;
  return Math.sqrt(sum / audio.length);
}

export function analyzeAudio(audio?: Float32Array): { kind: AudioKind; rms: number; message: string } {
  if (!audio?.length) return {
    kind: 'missing', rms: 0,
    message: 'Transcription audio was not captured. Playback may still have sound. Try recording again; if this continues, try another browser.',
  };
  const rms = audioRms(audio);
  if (!audio.some(sample => sample !== 0)) return {
    kind: 'silent', rms,
    message: 'The microphone input was silent. Check microphone permissions, your system or browser input selection, and hardware mute, then try again.',
  };
  return {
    kind: 'captured', rms,
    message: 'Audio input was captured. Play the test recording and listen for your voice. Input detection alone does not guarantee speech recognition.',
  };
}
