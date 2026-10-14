// Runs on the audio rendering thread. Each posted chunk is mono 16 kHz PCM.
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.phase = 0;
    this.sum = 0;
    this.samples = [];
    this.collecting = false;
    this.port.onmessage = (event) => {
      if (event.data === 'start') {
        this.phase = 0;
        this.sum = 0;
        this.samples = [];
        this.collecting = true;
      } else if (event.data === 'stop') {
        this.collecting = false;
        if (this.phase > 0) {
          const last = new Float32Array([this.sum / this.phase]);
          this.port.postMessage(last, [last.buffer]);
        }
        this.phase = 0;
        this.sum = 0;
      } else if (event.data === 'flush') {
        this.port.postMessage('flushed');
      }
    };
  }

  process(inputs) {
    if (!this.collecting) return true;
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;

    const ratio = 16000 / sampleRate;
    for (let i = 0; i < channels[0].length; i++) {
      let mono = 0;
      for (const channel of channels) mono += channel[i];
      mono /= channels.length;

      // Integrate each source sample into output sample intervals. This also
      // low-pass filters the usual 44.1/48 kHz microphone input when reducing it.
      let weight = ratio;
      while (weight > 0) {
        const portion = Math.min(weight, 1 - this.phase);
        this.sum += mono * portion;
        this.phase += portion;
        weight -= portion;
        if (this.phase >= 1 - 1e-7) {
          this.samples.push(this.sum);
          this.sum = 0;
          this.phase = 0;
        }
      }
    }

    if (this.samples.length > 0) {
      const chunk = new Float32Array(this.samples);
      this.samples = [];
      this.port.postMessage(chunk, [chunk.buffer]);
    }
    return true;
  }
}

registerProcessor('vcrecord-pcm', PCMProcessor);
