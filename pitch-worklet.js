/*
 * Pitch shift in tempo reale, senza cambiare la velocità.
 * Phase vocoder (Bernsee / smbPitchShift), una istanza per canale.
 * Sul telefono gira in un AudioWorklet; i test Node usano la stessa funzione.
 *
 * Il click non va passato a questo shifter: chi chiama ritarda il click
 * dello stesso numero di campioni (latencySamples) così resta allineato.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof AudioWorkletProcessor !== "undefined") {
    class CambiaPitchProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this.music = api.createShifter(sampleRate);
        this.clickDelay = api.createDelay(api.ALIGN);
        this.semitones = 0;
        this.speedSemitones = 0;
        const self = this;
        this.port.onmessage = function (event) {
          const data = event.data || {};
          if (typeof data.semitones === "number") self.semitones = data.semitones;
          if (typeof data.speedSemitones === "number") self.speedSemitones = data.speedSemitones;
          if (data.reset) {
            self.music.reset();
            if (self.clickShifter) self.clickShifter.reset();
            self.clickDelay = api.createDelay(api.ALIGN);
          }
        };
      }

      process(inputs, outputs) {
        const input = inputs[0];
        const output = outputs[0];
        if (!input || !input[0] || !output || !output[0]) return true;
        const musicIn = input[0];
        const clickIn = input[1] || new Float32Array(musicIn.length);
        const musicOut = output[0];
        const clickOut = output[1] || output[0];
        // La musica riceve la tonalità scelta, corretta se la velocità ha già spostato l'altezza.
        this.music.setSemitones(this.semitones - this.speedSemitones);
        this.music.process(musicIn, musicOut);
        // Il click non viene trasposto. Se la velocità ha abbassato tutto, lo si riporta su.
        if (Math.abs(this.speedSemitones) > 0.05) {
          if (!this.clickShifter) this.clickShifter = api.createShifter(sampleRate);
          this.clickShifter.setSemitones(-this.speedSemitones);
          this.clickShifter.process(clickIn, clickOut);
        } else {
          this.clickDelay.process(clickIn, clickOut);
        }
        return true;
      }
    }
    registerProcessor("cambia-pitch", CambiaPitchProcessor);
  }

  root.CambiaPitch = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const FFT = 2048;
  const OSAMP = 4;
  const STEP = FFT / OSAMP;
  const LATENCY = FFT - STEP;
  // Ritardo misurato sull'impulso a tonalità 0: il click va ritardato di altrettanto.
  const ALIGN = 2048;

  function createShifter(sampleRate) {
    const shifter = {
      sampleRate: sampleRate,
      fft: FFT,
      step: STEP,
      latency: LATENCY,
      freqPerBin: sampleRate / FFT,
      expect: (2 * Math.PI * STEP) / FFT,
      inFIFO: new Float32Array(FFT),
      outFIFO: new Float32Array(FFT),
      fftRe: new Float32Array(FFT),
      fftIm: new Float32Array(FFT),
      lastPhase: new Float32Array(FFT / 2 + 1),
      sumPhase: new Float32Array(FFT / 2 + 1),
      outputAccum: new Float32Array(FFT * 2),
      anaMagn: new Float32Array(FFT / 2 + 1),
      anaFreq: new Float32Array(FFT / 2 + 1),
      synMagn: new Float32Array(FFT / 2 + 1),
      synFreq: new Float32Array(FFT / 2 + 1),
      window: hann(FFT),
      rover: LATENCY,
      pitch: 1,
      gain: 1,
      inEnv: 0,
      outEnv: 0,
    };
    shifter.setSemitones = function (semitones) {
      const clamped = Math.max(-12, Math.min(12, semitones));
      shifter.pitch = Math.pow(2, clamped / 12);
    };
    shifter.reset = function () {
      shifter.inFIFO.fill(0);
      shifter.outFIFO.fill(0);
      shifter.lastPhase.fill(0);
      shifter.sumPhase.fill(0);
      shifter.outputAccum.fill(0);
      shifter.rover = LATENCY;
    };
    shifter.process = function (input, output) {
      processBlock(shifter, input, output);
    };
    return shifter;
  }

  function hann(n) {
    const window = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    }
    return window;
  }

  function fftRadix(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i += 1) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        const tr = re[i]; re[i] = re[j]; re[j] = tr;
        const ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = ((inverse ? 2 : -2) * Math.PI) / len;
      const wlenRe = Math.cos(ang);
      const wlenIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let wRe = 1;
        let wIm = 0;
        const half = len >> 1;
        for (let j = 0; j < half; j += 1) {
          const a = i + j;
          const b = a + half;
          const vRe = re[b] * wRe - im[b] * wIm;
          const vIm = re[b] * wIm + im[b] * wRe;
          re[b] = re[a] - vRe;
          im[b] = im[a] - vIm;
          re[a] += vRe;
          im[a] += vIm;
          const nextRe = wRe * wlenRe - wIm * wlenIm;
          wIm = wRe * wlenIm + wIm * wlenRe;
          wRe = nextRe;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i += 1) {
        re[i] /= n;
        im[i] /= n;
      }
    }
  }

  function wrapPi(value) {
    return value - 2 * Math.PI * Math.round(value / (2 * Math.PI));
  }

  function processBlock(st, input, output) {
    const fftSize = st.fft;
    const half = fftSize / 2;
    const step = st.step;
    for (let i = 0; i < input.length; i += 1) {
      st.inFIFO[st.rover] = input[i];
      const read = st.rover - st.latency;
      let sample = read >= 0 ? st.outFIFO[read] : 0;
      const inAbs = Math.abs(input[i]);
      st.inEnv = st.inEnv * 0.999 + inAbs * 0.001;
      st.outEnv = st.outEnv * 0.999 + Math.abs(sample) * 0.001;
      if (st.outEnv > 0.0008 && st.inEnv > 0.0008) {
        const target = Math.max(0.25, Math.min(4, st.inEnv / st.outEnv));
        st.gain += (target - st.gain) * 0.01;
      }
      output[i] = sample * st.gain;
      st.rover += 1;
      if (st.rover < fftSize) continue;
      st.rover = st.latency;
      for (let k = 0; k < fftSize; k += 1) {
        st.fftRe[k] = st.inFIFO[k] * st.window[k];
        st.fftIm[k] = 0;
      }
      fftRadix(st.fftRe, st.fftIm, false);
      for (let k = 0; k <= half; k += 1) {
        const real = st.fftRe[k];
        const imag = st.fftIm[k];
        const magn = 2 * Math.sqrt(real * real + imag * imag);
        const phase = Math.atan2(imag, real);
        let delta = phase - st.lastPhase[k];
        st.lastPhase[k] = phase;
        delta -= k * st.expect;
        delta = wrapPi(delta);
        const deviation = (delta * OSAMP) / (2 * Math.PI);
        st.anaMagn[k] = magn;
        st.anaFreq[k] = (k + deviation) * st.freqPerBin;
      }
      st.synMagn.fill(0);
      st.synFreq.fill(0);
      const pitch = st.pitch;
      for (let k = 0; k <= half; k += 1) {
        const index = Math.round(k * pitch);
        if (index <= half) {
          st.synMagn[index] += st.anaMagn[k];
          st.synFreq[index] = st.anaFreq[k] * pitch;
        }
      }
      for (let k = 0; k <= half; k += 1) {
        let tmp = st.synFreq[k];
        tmp -= k * st.freqPerBin;
        tmp /= st.freqPerBin;
        tmp = (2 * Math.PI * tmp) / OSAMP;
        tmp += k * st.expect;
        st.sumPhase[k] += tmp;
        const phase = st.sumPhase[k];
        st.fftRe[k] = st.synMagn[k] * Math.cos(phase);
        st.fftIm[k] = st.synMagn[k] * Math.sin(phase);
      }
      for (let k = 1; k < half; k += 1) {
        st.fftRe[fftSize - k] = st.fftRe[k];
        st.fftIm[fftSize - k] = -st.fftIm[k];
      }
      fftRadix(st.fftRe, st.fftIm, true);
      const scale = 2 / (half * OSAMP);
      for (let k = 0; k < fftSize; k += 1) {
        st.outputAccum[k] += st.window[k] * st.fftRe[k] * scale * fftSize;
      }
      for (let k = 0; k < step; k += 1) st.outFIFO[k] = st.outputAccum[k];
      st.outputAccum.copyWithin(0, step);
      st.outputAccum.fill(0, st.outputAccum.length - step);
      st.inFIFO.copyWithin(0, step);
    }
  }

  function createDelay(latency) {
    const buf = new Float32Array(Math.max(1, latency));
    let pos = 0;
    return {
      process: function (input, output) {
        for (let i = 0; i < input.length; i += 1) {
          output[i] = buf[pos];
          buf[pos] = input[i];
          pos += 1;
          if (pos >= buf.length) pos = 0;
        }
      },
    };
  }

  return {
    FFT: FFT,
    LATENCY: LATENCY,
    ALIGN: ALIGN,
    createShifter: createShifter,
    createDelay: createDelay,
  };
});
