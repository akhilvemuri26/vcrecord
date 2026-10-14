import { pipeline, env } from '@huggingface/transformers';
env.allowLocalModels = false;
let recognizer: any;
self.onmessage = async (event: MessageEvent<{
    id: string;
    audio: Float32Array;
}>) => {
    const { id, audio } = event.data;
    try {
        let sum = 0;
        for (const n of audio)
            sum += n * n;
        if (!audio.length || Math.sqrt(sum / audio.length) < 0.003) {
            self.postMessage({ id, status: 'silent', text: '' });
            return;
        }
        recognizer ??= await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', { device: 'wasm', dtype: 'q8', progress_callback: (p: any) => self.postMessage({ id, status: 'progress', message: p.status === 'progress' ? `Downloading speech model: ${Math.round(p.progress ?? 0)}%` : 'Loading local speech model…' }) });
        const result = await recognizer(audio, { sampling_rate: 16000 });
        const text = String(result.text ?? '').trim();
        self.postMessage({ id, status: text ? 'done' : 'silent', text });
    }
    catch (error) {
        self.postMessage({ id, status: 'error', error: error instanceof Error ? error.message : String(error) });
    }
};
