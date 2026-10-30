// AudioWorklet: forwards mono audio frames (~20 ms) to the main thread.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameSize = Math.round(sampleRate * 0.02);
    this.buf = new Float32Array(this.frameSize);
    this.pos = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const chans = input.length;
    const len = input[0].length;
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let c = 0; c < chans; c++) s += input[c][i];
      this.buf[this.pos++] = s / chans;
      if (this.pos === this.frameSize) {
        this.port.postMessage(this.buf.slice(0));
        this.pos = 0;
      }
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
