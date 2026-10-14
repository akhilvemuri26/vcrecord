export interface CaptureResult {
  video: Blob;
  audio: Float32Array;
  duration: number;
  mime: string;
}

export interface CaptureHandle {
  /** Cancels setup/preparation, or stops and saves an active answer. */
  stop: () => void;
}

export interface CaptureOptions {
  preparationSeconds?: number;
  answerSeconds?: number;
  signal?: AbortSignal;
  onPhase?: (phase: 'preparing' | 'recording') => void;
  onCancelled?: () => void;
}

function recordingMime(): string | undefined {
  return [
    'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4',
  ].find((mime) => MediaRecorder.isTypeSupported(mime));
}

function workletUrl(): string {
  const base = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  return new URL(`${base}pcm-worklet.js`, document.baseURI).href;
}

function joinPcm(chunks: Float32Array[]): Float32Array {
  const result = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export async function startCapture(
  preview: HTMLVideoElement,
  onTick: (remaining: number) => void,
  onFinished: (result: CaptureResult) => void,
  onError: (error: Error) => void,
  options: CaptureOptions = {},
): Promise<CaptureHandle> {
  const preparationSeconds = options.preparationSeconds ?? 15;
  const answerSeconds = options.answerSeconds ?? 20;
  if (!Number.isInteger(preparationSeconds) || preparationSeconds < 1 || preparationSeconds > 120 ||
      !Number.isInteger(answerSeconds) || answerSeconds < 5 || answerSeconds > 30) {
    throw new Error('Preparation must be 1–120 whole seconds and answer must be 5–30 whole seconds.');
  }
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
  let cancelled = false;
  let recording = false;
  let finished = false;
  let stopping = false;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let finalizationTimer: ReturnType<typeof setTimeout> | undefined;
  let stopRecording: (() => void) | undefined;
  let rejectCancellation!: (error: Error) => void;
  const cancellation = new Promise<never>((_, reject) => { rejectCancellation = reject; });
  // Cancellation can happen after setup has returned, when no setup await remains.
  void cancellation.catch(() => {});
  const cancellationError = new Error('Recording setup or preparation was cancelled. Try again while this page is visible.');
  const releaseResources = () => {
    stream?.getTracks().forEach((track) => track.stop());
    if (stream && preview.srcObject === stream) preview.srcObject = null;
    source?.disconnect();
    worklet?.disconnect();
    mute?.disconnect();
    if (context && context.state !== 'closed') void context.close().catch(() => {});
  };
  const removeLifecycleListeners = () => {
    document.removeEventListener('visibilitychange', stopOnHidden);
    window.removeEventListener('pagehide', stopForLifecycle);
    options.signal?.removeEventListener('abort', stopForLifecycle);
    stream?.getTracks().forEach((track) => track.removeEventListener('ended', stopForLifecycle));
  };
  const cleanup = () => {
    if (tickTimer !== undefined) clearInterval(tickTimer);
    if (finalizationTimer !== undefined) clearTimeout(finalizationTimer);
    removeLifecycleListeners();
    window.removeEventListener('beforeunload', warnBeforeUnload);
    if (worklet) worklet.port.onmessage = null;
    releaseResources();
  };
  function stopForLifecycle() {
    if (finished || cancelled) return;
    if (recording) { stopRecording?.(); return; }
    cancelled = true;
    cleanup();
    rejectCancellation(cancellationError);
    options.onCancelled?.();
  }
  function stopOnHidden() {
    if (document.visibilityState === 'hidden') stopForLifecycle();
  }
  function warnBeforeUnload(event: BeforeUnloadEvent) {
    if (finished) return;
    event.preventDefault();
    event.returnValue = '';
  }
  const checkSetup = () => {
    if (options.signal?.aborted || document.visibilityState === 'hidden') stopForLifecycle();
    if (cancelled) throw cancellationError;
  };
  const waitForSetup = async <T>(promise: Promise<T>): Promise<T> => {
    const result = await Promise.race([promise, cancellation]);
    checkSetup();
    return result;
  };
  document.addEventListener('visibilitychange', stopOnHidden);
  window.addEventListener('pagehide', stopForLifecycle);
  options.signal?.addEventListener('abort', stopForLifecycle);

  try {
    checkSetup();
    const permission = navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    // A late permission grant must release its stream even after the race rejected.
    void permission.then((granted) => {
      if (cancelled) granted.getTracks().forEach((track) => track.stop());
    }, () => {});
    stream = await waitForSetup(permission);
    stream.getTracks().forEach((track) => track.addEventListener('ended', stopForLifecycle));
    preview.muted = true;
    preview.playsInline = true;
    preview.srcObject = stream;
    await waitForSetup(preview.play());
    context = new AudioContext();
    await waitForSetup(context.audioWorklet.addModule(workletUrl()));
    source = context.createMediaStreamSource(stream);
    worklet = new AudioWorkletNode(context, 'vcrecord-pcm', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    });
    mute = context.createGain();
    mute.gain.value = 0;
    source.connect(worklet);
    worklet.connect(mute);
    mute.connect(context.destination);
    await waitForSetup(context.resume());
    if (context.state !== 'running') throw new Error('Audio could not start automatically. Use Start practice to enable camera and microphone.');

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
    let stoppedAt = 0;
    let recordingError: Error | undefined;
    const finalize = async () => {
      if (finished || cancelled) return;
      finished = true;
      const duration = Math.max(0, (stoppedAt || performance.now()) - startedAt) / 1000;
      const mime = recorder.mimeType || videoChunks.find((chunk) => chunk.type)?.type || 'video/webm';
      const video = new Blob(videoChunks, { type: mime });
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 250);
        resolvePcmFlush = () => { clearTimeout(timeout); resolve(); };
        try { worklet!.port.postMessage('stop'); worklet!.port.postMessage('flush'); }
        catch { clearTimeout(timeout); resolve(); }
      });
      const audio = joinPcm(pcmChunks);
      cleanup();
      if (video.size > 0) onFinished({ video, audio, duration, mime });
      else onError(recordingError ?? new Error('The recording was empty. Check camera and microphone access, then try again.'));
    };
    function requestStop() {
      if (stopping || finished) return;
      stopping = true;
      stoppedAt = performance.now();
      if (tickTimer !== undefined) clearInterval(tickTimer);
      try { worklet!.port.postMessage('stop'); } catch { /* Save video if the worklet closed. */ }
      try { if (recorder.state !== 'inactive') recorder.stop(); }
      catch (error) {
        recordingError = error instanceof Error ? error : new Error(String(error));
        void finalize();
        return;
      }
      if (!finished) finalizationTimer = setTimeout(() => {
        recordingError ??= new Error('The browser did not finish the recording.');
        void finalize();
      }, 4000);
    }
    stopRecording = requestStop;
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) videoChunks.push(event.data);
    });
    recorder.addEventListener('error', (event) => {
      recordingError = (event as Event & { error?: Error }).error ?? new Error('The browser reported a recording error.');
      if (recording) requestStop();
      else { finished = true; cleanup(); onError(recordingError); }
    });
    recorder.addEventListener('stop', finalize, { once: true });
    const beginRecording = () => {
      if (recording || finished || cancelled) return;
      try {
        checkSetup();
        recorder.start(1000);
        recording = true;
        startedAt = performance.now();
        worklet!.port.postMessage('start');
        window.addEventListener('beforeunload', warnBeforeUnload);
        options.onPhase?.('recording');
        if (!stopping && !finished) onTick(answerSeconds);
      } catch (error) {
        if (cancelled) return;
        finished = true;
        cleanup();
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    };
    checkSetup();
    const preparationDeadline = performance.now() + preparationSeconds * 1000;
    options.onPhase?.('preparing');
    if (!cancelled && !finished) {
      onTick(preparationSeconds);
    }
    if (!cancelled && !finished) {
      tickTimer = setInterval(() => {
        if (cancelled || finished || stopping) return;
        if (!recording) {
          const remaining = preparationDeadline - performance.now();
          if (remaining <= 0) beginRecording();
          else onTick(Math.ceil(remaining / 1000));
        } else {
          const remaining = answerSeconds * 1000 - (performance.now() - startedAt);
          onTick(Math.max(0, Math.ceil(remaining / 1000)));
          if (remaining <= 0) requestStop();
        }
      }, 100);
    }
    return { stop: stopForLifecycle };
  } catch (error) {
    cleanup();
    throw error instanceof Error ? error : new Error(String(error));
  }
}
