/* Mix per la sala prove: click su un solo canale, musica mono sull'altro.
   Il conteggio iniziale esiste solo nel click. Stessa griglia di cover_rock/rehearsal.py. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CambiaMix = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const PRESETS = {
    voce: ["voce"],
    base: ["batteria", "basso", "altro"],
    tutto: ["voce", "batteria", "basso", "altro"],
  };

  function planRehearsal(track, leadBars, invert) {
    const bars = Number(leadBars) || 0;
    if ([0, 1, 2, 4].indexOf(bars) === -1) {
      throw new Error("Il click può partire 0, 1, 2 o 4 battute prima della musica.");
    }
    const beats = track.beats || [];
    if (beats.length < 2) throw new Error("Servono almeno due battiti.");
    const anchor = beats.find(function (beat) { return beat.downbeat; }) || beats[0];
    const interval = 60 / Math.max(40, anchor.bpm || track.bpm || 120);
    const meter = Math.max(1, track.beatsPerBar || 4);
    const hits = [];
    let leadSeconds = 0;
    if (bars > 0) {
      const count = bars * meter;
      const requested = count * interval;
      const stepIndex = Math.floor((-1e-6 - anchor.time) / interval);
      const countIn = [];
      for (let offset = 0; offset < count; offset += 1) {
        const songTime = anchor.time + (stepIndex - offset) * interval;
        const steps = Math.round((anchor.time - songTime) / interval);
        countIn.push({ songTime: songTime, steps: steps });
      }
      const earliest = countIn.reduce(function (min, item) {
        return Math.min(min, item.songTime);
      }, 0);
      leadSeconds = Math.max(requested, -earliest);
      countIn.forEach(function (item) {
        const phase = ((item.steps % meter) + meter) % meter;
        const position = phase === 0 ? 1 : meter - phase + 1;
        hits.push({
          songTime: item.songTime,
          fileTime: item.songTime + leadSeconds,
          downbeat: phase === 0,
          position: position,
          countIn: true,
        });
      });
    }
    beats.forEach(function (beat) {
      if (beat.time < -0.001 || beat.time > (track.duration || 0) + 0.05) return;
      hits.push({
        songTime: beat.time,
        fileTime: beat.time + leadSeconds,
        downbeat: !!beat.downbeat,
        position: beat.position || 1,
        countIn: false,
      });
    });
    hits.sort(function (a, b) { return a.fileTime - b.fileTime; });
    return {
      leadSeconds: leadSeconds,
      hits: hits,
      musicStart: leadSeconds,
      duration: leadSeconds + (track.duration || 0),
      clickChannel: invert ? 1 : 0,
      musicChannel: invert ? 0 : 1,
    };
  }

  function synthesizeClicks(duration, hits, volume, sampleRate) {
    const total = Math.max(1, Math.round(duration * sampleRate));
    const wave = new Float32Array(total);
    const gain = Math.max(0, Math.min(100, volume)) / 100;
    if (gain <= 0) return wave;
    hits.forEach(function (hit) {
      const start = Math.round(hit.fileTime * sampleRate);
      if (start < 0 || start >= total) return;
      const down = !!hit.downbeat;
      const freq = down ? 1760 : 988;
      const amp = (down ? 0.92 : 0.48) * gain;
      const length = Math.floor(sampleRate * (down ? 0.035 : 0.022));
      const end = Math.min(total, start + length);
      for (let i = start; i < end; i += 1) {
        const t = (i - start) / sampleRate;
        const env = Math.exp(-t * 75);
        const tone = Math.sin(2 * Math.PI * freq * t);
        const burst = i - start < sampleRate * 0.0025 ? 1 - (i - start) / (sampleRate * 0.0025) : 0;
        wave[i] += amp * (0.78 * tone + 0.22 * burst) * env;
      }
    });
    return wave;
  }

  function limitPeak(channel) {
    let peak = 0;
    for (let i = 0; i < channel.length; i += 1) peak = Math.max(peak, Math.abs(channel[i]));
    if (peak > 0.98) {
      const scale = 0.98 / peak;
      for (let i = 0; i < channel.length; i += 1) channel[i] *= scale;
    }
    return channel;
  }

  function renderStereo(options) {
    const plan = options.plan;
    const sampleRate = options.sampleRate;
    const total = Math.max(1, Math.round(plan.duration * sampleRate));
    const click = synthesizeClicks(plan.duration, plan.hits, options.clickVolume, sampleRate);
    const music = new Float32Array(total);
    const source = options.music;
    const start = Math.round(plan.musicStart * sampleRate);
    const gain = Math.max(0, Math.min(100, options.musicVolume)) / 100;
    const count = Math.min(source.length, total - start);
    if (gain > 0 && count > 0) {
      for (let i = 0; i < count; i += 1) music[start + i] = source[i] * gain;
    }
    limitPeak(click);
    limitPeak(music);
    const left = plan.clickChannel === 0 ? click : music;
    const right = plan.clickChannel === 0 ? music : click;
    return { left: left, right: right, sampleRate: sampleRate, plan: plan };
  }

  function encodeWav(left, right, sampleRate) {
    const n = Math.min(left.length, right.length);
    const buffer = new ArrayBuffer(44 + n * 4);
    const view = new DataView(buffer);
    function text(offset, value) {
      for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
    }
    text(0, "RIFF");
    view.setUint32(4, 36 + n * 4, true);
    text(8, "WAVE");
    text(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, n * 4, true);
    let offset = 44;
    for (let i = 0; i < n; i += 1) {
      const l = Math.max(-1, Math.min(1, left[i]));
      const r = Math.max(-1, Math.min(1, right[i]));
      view.setInt16(offset, l * 32767, true);
      view.setInt16(offset + 2, r * 32767, true);
      offset += 4;
    }
    return new Uint8Array(buffer);
  }

  function sumMusic(channels, included, volumes, musicVolume) {
    const length = channels.reduce(function (max, item) {
      return Math.max(max, item.samples.length);
    }, 0);
    const out = new Float32Array(length);
    const master = Math.max(0, Math.min(100, musicVolume)) / 100;
    channels.forEach(function (item) {
      if (included.indexOf(item.id) === -1) return;
      const gain = master * (Math.max(0, Math.min(100, volumes[item.id] == null ? 100 : volumes[item.id])) / 100);
      const data = item.samples;
      for (let i = 0; i < data.length; i += 1) out[i] += data[i] * gain;
    });
    return limitPeak(out);
  }

  return {
    PRESETS: PRESETS,
    planRehearsal: planRehearsal,
    synthesizeClicks: synthesizeClicks,
    renderStereo: renderStereo,
    encodeWav: encodeWav,
    sumMusic: sumMusic,
  };
});
