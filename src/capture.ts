export interface CaptureResult {
  video: Blob;
  audio: Float32Array;
  duration: number;
  mime: string;
}

export interface CaptureHandle {
  stop: () => void;
}

const MAX_DURATION_MS = 15_000;

function recordingMime(): string | undefined {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
  ];
  return candidates.find((mime) => MediaRecorder.isTypeSupported(mime));
}

function workletUrl(): string {
  const base = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  return new URL(`${base}pcm-worklet.js`, document.baseURI).href;
}

function joinPcm(chunks: Float32Array[]): Float32Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export async function startCapture(
  preview: HTMLVideoElement,
  onTick: (remaining: number) => void,
  onFinished: (result: CaptureResult) => void,
  onError: (error: Error) => void,
): Promise<CaptureHandle> {
  if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) {
    throw new Error('Camera and microphone recording is unavailable in this browser or context.');
  }
  if (!globalThis.AudioContext || !globalThis.AudioWorkletNode) {
    throw new Error('This browser cannot capture audio for local transcription.');
  }

  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let worklet: AudioWorkletNode | undefined;
  let mute: GainNode | undefined;

  let setupCancelled = false;
  let stopRecording: (() => void) | undefined;
  const releaseResources = () => {
    stream?.getTracks().forEach((track) => track.stop());
    if (preview.srcObject === stream) preview.srcObject = null;
    source?.disconnect();
    worklet?.disconnect();
    mute?.disconnect();
    if (context && context.state !== 'closed') void context.close().catch(() => {});
  };
  const stopForLifecycle = () => {
    if (stopRecording) stopRecording();
    else {
      setupCancelled = true;
      releaseResources();
    }
  };
  const stopOnHidden = () => {
    if (document.visibilityState === 'hidden') stopForLifecycle();
  };
  const removeLifecycleListeners = () => {
    document.removeEventListener('visibilitychange', stopOnHidden);
    window.removeEventListener('pagehide', stopForLifecycle);
    stream?.getTracks().forEach((track) => track.removeEventListener('ended', stopForLifecycle));
  };
  const checkSetup = () => {
    if (setupCancelled || document.visibilityState === 'hidden') {
      throw new Error('Recording setup was cancelled because the page was hidden. Try again while this page is visible.');
    }
  };
  // Permission prompts, playback and worklet startup can all outlive the visible page.
  document.addEventListener('visibilitychange', stopOnHidden);
  window.addEventListener('pagehide', stopForLifecycle);

  try {
    checkSetup();
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    checkSetup();
    stream.getTracks().forEach((track) => track.addEventListener('ended', stopForLifecycle));

    preview.muted = true;
    preview.playsInline = true;
    preview.srcObject = stream;
    await preview.play();
    checkSetup();

    context = new AudioContext();
    await context.audioWorklet.addModule(workletUrl());
    checkSetup();
    source = context.createMediaStreamSource(stream);
    worklet = new AudioWorkletNode(context, 'vcrecord-pcm', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    mute = context.createGain();
    mute.gain.value = 0;
    source.connect(worklet);
    worklet.connect(mute);
    mute.connect(context.destination);
    await context.resume();
    checkSetup();

    const pcmChunks: Float32Array[] = [];
    const videoChunks: Blob[] = [];
    let resolvePcmFlush: (() => void) | undefined;
    worklet.port.onmessage = (event: MessageEvent<Float32Array | 'flushed'>) => {
      if (event.data instanceof Float32Array) pcmChunks.push(event.data);
      else if (event.data === 'flushed') resolvePcmFlush?.();
    };

    const mimeChoice = recordingMime();
    const recorder = new MediaRecorder(stream, mimeChoice ? { mimeType: mimeChoice } : undefined);
    let startedAt = 0;
    let tickTimer: ReturnType<typeof setInterval> | undefined;
    let finalizationTimer: ReturnType<typeof setTimeout> | undefined;
    let stopping = false;
    let stoppedAt = 0;
    let finished = false;
    let recordingError: Error | undefined;

    const cleanup = () => {
      if (tickTimer !== undefined) clearInterval(tickTimer);
      if (finalizationTimer !== undefined) clearTimeout(finalizationTimer);
      removeLifecycleListeners();
      window.removeEventListener('beforeunload', warnBeforeUnload);
      worklet!.port.onmessage = null;
      releaseResources();
    };

    const finalize = async () => {
      if (finished) return;
      finished = true;
      const duration = Math.max(0, (stoppedAt || performance.now()) - startedAt) / 1000;
      const mime = recorder.mimeType || videoChunks.find((chunk) => chunk.type)?.type || 'video/webm';
      const video = new Blob(videoChunks, { type: mime });
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 250);
        resolvePcmFlush = () => {
          clearTimeout(timeout);
          resolve();
        };
        try {
          worklet!.port.postMessage('stop');
          worklet!.port.postMessage('flush');
        } catch {
          clearTimeout(timeout);
          resolve();
        }
      });
      const audio = joinPcm(pcmChunks);
      cleanup();

      if (video.size > 0) {
        onFinished({ video, audio, duration, mime });
      } else {
        onError(recordingError ?? new Error('The recording was empty. Check camera and microphone access, then try again.'));
      }
    };

    function requestStop() {
      if (stopping || finished) return;
      stopping = true;
      stoppedAt = performance.now();
      if (tickTimer !== undefined) clearInterval(tickTimer);
      try {
        worklet!.port.postMessage('stop');
      } catch {
        // Finalize the video even if the audio worklet has already closed.
      }
      // MediaRecorder emits the final dataavailable before its stop event.
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch (error) {
        recordingError = error instanceof Error ? error : new Error(String(error));
        finalize();
        return;
      }
      finalizationTimer = setTimeout(() => {
        recordingError ??= new Error('The browser did not finish the recording.');
        finalize();
      }, 4000);
    }

    function warnBeforeUnload(event: BeforeUnloadEvent) {
      if (finished) return;
      event.preventDefault();
      event.returnValue = '';
    }

    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) videoChunks.push(event.data);
    });
    recorder.addEventListener('error', (event) => {
      const mediaError = (event as Event & { error?: Error }).error;
      recordingError = mediaError ?? new Error('The browser reported a recording error.');
      requestStop();
    });
    recorder.addEventListener('stop', finalize, { once: true });
    checkSetup();
    recorder.start(1000);
    stopRecording = requestStop;
    startedAt = performance.now();
    worklet.port.postMessage('start');
    window.addEventListener('beforeunload', warnBeforeUnload);
    onTick(15);
    tickTimer = setInterval(() => {
      const remainingMs = MAX_DURATION_MS - (performance.now() - startedAt);
      onTick(Math.max(0, Math.ceil(remainingMs / 1000)));
      if (remainingMs <= 0) requestStop();
    }, 100);

    return { stop: requestStop };
  } catch (error) {
    removeLifecycleListeners();
    releaseResources();
    throw error instanceof Error ? error : new Error(String(error));
  }
}
