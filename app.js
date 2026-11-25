/* Player di sala prove. Un solo file audio stereo: il click non può finire sull'altro canale. */
(function () {
  const beatApi = globalThis.CambiaBeat;
  const mixApi = globalThis.CambiaMix;
  const unzipApi = globalThis.CambiaUnzip;
  const DB_NAME = "cambia-genere-player";
  const STORE = "songs";

  const audio = document.getElementById("stage");
  const state = {
    song: null,
    monos: [],
    sampleRate: 44100,
    url: null,
    leadSeconds: 0,
    duration: 0,
    playing: false,
    loopOn: false,
    loopA: 0,
    loopB: null,
    included: ["voce"],
    volumes: { voce: 100, batteria: 100, basso: 100, altro: 100 },
    clickVolume: 80,
    musicVolume: 100,
    leadBars: 1,
    invert: false,
    speed: 1,
    semitones: 0,
    building: false,
    dirty: true,
    offset: 0,
    startedAt: 0,
  };

  function $(id) { return document.getElementById(id); }

  function openDb() {
    return new Promise(function (resolve, reject) {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = function () {
        request.result.createObjectStore(STORE, { keyPath: "id" });
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  async function idbAll() {
    const db = await openDb();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).getAll();
      request.onsuccess = function () { resolve(request.result || []); };
      request.onerror = function () { reject(request.error); };
    });
  }

  async function idbPut(record) {
    const db = await openDb();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(record);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  async function idbDelete(id) {
    const db = await openDb();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  function setStatus(text) { $("status").textContent = text; }

  const PITCH_LATENCY_SEC = 2048 / 44100;

  function engineFileTime() {
    if (!state.playing || !state.ctx) return state.offset || 0;
    return state.offset + (state.ctx.currentTime - state.startedAt) * state.speed;
  }

  function songTime() {
    const heard = Math.max(0, engineFileTime() - PITCH_LATENCY_SEC);
    return heard - state.leadSeconds;
  }

  function fileTimeForSong(time) {
    return Math.max(0, time + state.leadSeconds);
  }

  function activeHit(plan, timeInFile) {
    const songT = timeInFile - plan.leadSeconds;
    let chosen = null;
    plan.hits.forEach(function (hit) {
      if (hit.fileTime <= timeInFile + 0.04) chosen = hit;
    });
    return { hit: chosen, songTime: songT };
  }

  function renderBeatFace() {
    if (!state.song) return;
    const plan = mixApi.planRehearsal(state.song.beats, state.leadBars, state.invert);
    const info = activeHit(plan, Math.max(0, engineFileTime() - PITCH_LATENCY_SEC));
    const face = $("beat");
    const label = $("beat-label");
    if (!info.hit || info.songTime < -state.leadSeconds - 0.05) {
      face.textContent = "·";
      face.className = "beat";
      label.textContent = "In attesa";
      return;
    }
    const recent = Math.abs((engineFileTime() - PITCH_LATENCY_SEC) - info.hit.fileTime) < 0.12;
    face.textContent = String(info.hit.position);
    face.className = "beat" + (info.hit.downbeat ? " down" : "") + (recent ? " on" : "");
    if (info.songTime < 0) {
      label.textContent = "Conteggio, solo nel click";
    } else {
      const section = beatApi.sectionAt(state.song.beats.sections, info.songTime);
      label.textContent = section ? "Adesso " + String(section.bpm).replace(".", ",") + " BPM" : state.song.beats.meter;
    }
    const shown = Math.max(0, info.songTime);
    $("clock").textContent = beatApi.formatClock(shown) + " / " + beatApi.formatClock(state.duration);
    if (!state.seeking) $("seek").value = String(Math.min(state.duration, shown));
  }

  function loopWatch() {
    if (!state.loopOn || state.loopB == null) return;
    const end = fileTimeForSong(state.loopB);
    if (engineFileTime() >= end - 0.02 && !state.loopJumping) {
      state.loopJumping = true;
      startAt(fileTimeForSong(state.loopA)).finally(function () { state.loopJumping = false; });
    }
  }

  function unlockAudio() {
    if (navigator.audioSession) navigator.audioSession.type = "playback";
    audio.playsInline = true;
    audio.setAttribute("playsinline", "");
  }

  function applySpeed() {
    $("pitch-note").hidden = true;
  }

  async function decodeMono(ctx, bytes) {
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const decoded = await ctx.decodeAudioData(copy);
    const mono = new Float32Array(decoded.length);
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      const data = decoded.getChannelData(channel);
      for (let i = 0; i < data.length; i += 1) mono[i] += data[i] / decoded.numberOfChannels;
    }
    return { samples: mono, sampleRate: decoded.sampleRate };
  }

  function resample(samples, fromRate, toRate) {
    if (fromRate === toRate) return samples;
    const length = Math.max(1, Math.round(samples.length * toRate / fromRate));
    const out = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      const pos = i * fromRate / toRate;
      const index = Math.floor(pos);
      const frac = pos - index;
      const a = samples[Math.min(index, samples.length - 1)] || 0;
      const b = samples[Math.min(index + 1, samples.length - 1)] || 0;
      out[i] = a + (b - a) * frac;
    }
    return out;
  }

  async function prepareSong(record) {
    unlockAudio();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const monos = [];
    for (let i = 0; i < record.manifest.stems.length; i += 1) {
      const stem = record.manifest.stems[i];
      const blob = record.files[stem.file];
      if (!blob) throw new Error("Manca il file " + stem.file + ".");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const decoded = await decodeMono(ctx, bytes);
      monos.push({
        id: stem.id,
        label: stem.label,
        samples: resample(decoded.samples, decoded.sampleRate, 44100),
      });
    }
    if (ctx.close) ctx.close();
    state.monos = monos;
    state.sampleRate = 44100;
    state.song = record;
    state.duration = record.beats.duration || record.manifest.duration;
    state.semitones = typeof record.semitones === "number"
      ? record.semitones
      : (record.manifest.semitones || 0);
    state.semitones = Math.max(-6, Math.min(6, state.semitones | 0));
    showTone();
    state.dirty = true;
    $("seek").max = String(state.duration);
    $("title").textContent = record.manifest.title;
    const bpm = String(record.beats.bpm).replace(".", ",");
    $("meta").textContent = "BPM medio " + bpm + " · " + (record.beats.meter || "");
    const unsure = record.beats.downbeatConfident === false;
    $("unsure").hidden = !unsure;
    buildStemRows();
    $("player").hidden = false;
    await rebuild(false);
  }

  function buildStemRows() {
    const root = $("stems");
    root.innerHTML = "";
    state.song.manifest.stems.forEach(function (stem) {
      const row = document.createElement("div");
      row.className = "stem";
      const checked = state.included.indexOf(stem.id) !== -1;
      row.innerHTML =
        '<label class="check"><input type="checkbox" data-id="' + stem.id + '"' + (checked ? " checked" : "") + "> " +
        stem.label + "</label>" +
        '<button type="button" class="solo" data-solo="' + stem.id + '">Solo</button>' +
        '<input type="range" min="0" max="100" value="' + (state.volumes[stem.id] || 100) + '" data-vol="' + stem.id + '" aria-label="Volume ' + stem.label + '">';
      root.appendChild(row);
    });
    root.querySelectorAll("input[type=checkbox]").forEach(function (box) {
      box.addEventListener("change", function () {
        const id = box.getAttribute("data-id");
        if (box.checked) {
          if (state.included.indexOf(id) === -1) state.included.push(id);
        } else {
          state.included = state.included.filter(function (item) { return item !== id; });
        }
        scheduleRebuild();
      });
    });
    root.querySelectorAll("button.solo").forEach(function (button) {
      button.addEventListener("click", function () {
        state.included = [button.getAttribute("data-solo")];
        buildStemRows();
        scheduleRebuild();
      });
    });
    root.querySelectorAll("input[type=range]").forEach(function (slider) {
      slider.addEventListener("input", function () {
        state.volumes[slider.getAttribute("data-vol")] = Number(slider.value);
        scheduleRebuild();
      });
    });
  }

  function musicBuffer() {
    if (!state.included.length) {
      throw new Error("Scegli almeno una traccia per le casse.");
    }
    return mixApi.sumMusic(state.monos, state.included, state.volumes, state.musicVolume);
  }

  function showTone() {
    const box = $("tone-value");
    if (!box) return;
    box.textContent = state.semitones > 0 ? "+" + state.semitones : String(state.semitones);
  }

  function speedSemitones() {
    return 12 * Math.log(state.speed) / Math.log(2);
  }

  function postPitch() {
    if (!state.worklet) return;
    state.worklet.port.postMessage({
      semitones: state.semitones,
      speedSemitones: speedSemitones(),
    });
  }

  async function ensureEngine() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!state.ctx) state.ctx = new Ctx();
    if (state.ctx.state === "suspended") await state.ctx.resume();
    if (!state.workletReady) {
      await state.ctx.audioWorklet.addModule("./pitch-worklet.js");
      state.workletReady = true;
    }
  }

  function stopSources() {
    if (state.playing && state.ctx) state.offset = engineFileTime();
    state.playing = false;
    state.startedAt = 0;
    ["musicSrc", "clickSrc", "outputMerge", "worklet"].forEach(function (key) {
      if (!state[key]) return;
      try { state[key].stop(); } catch (error) { /* non è una sorgente */ }
      try { state[key].disconnect(); } catch (error) { /* già staccato */ }
      state[key] = null;
    });
    if (audio.srcObject) {
      audio.pause();
    }
    $("play").textContent = "Play";
  }

  function bufferFrom(samples) {
    const buffer = state.ctx.createBuffer(1, samples.length, 44100);
    buffer.getChannelData(0).set(samples);
    return buffer;
  }

  async function startAt(fileTime) {
    await ensureEngine();
    stopSources();
    state.offset = Math.max(0, fileTime);
    const musicSrc = state.ctx.createBufferSource();
    const clickSrc = state.ctx.createBufferSource();
    musicSrc.buffer = bufferFrom(state.musicSamples);
    clickSrc.buffer = bufferFrom(state.clickSamples);
    musicSrc.playbackRate.value = state.speed;
    clickSrc.playbackRate.value = state.speed;
    const inputMerge = state.ctx.createChannelMerger(2);
    musicSrc.connect(inputMerge, 0, 0);
    clickSrc.connect(inputMerge, 0, 1);
    const worklet = new AudioWorkletNode(state.ctx, "cambia-pitch", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: "explicit",
      channelInterpretation: "discrete",
    });
    inputMerge.connect(worklet);
    const split = state.ctx.createChannelSplitter(2);
    worklet.connect(split);
    const outputMerge = state.ctx.createChannelMerger(2);
    if (!state.invert) {
      split.connect(outputMerge, 1, 0);
      split.connect(outputMerge, 0, 1);
    } else {
      split.connect(outputMerge, 0, 0);
      split.connect(outputMerge, 1, 1);
    }
    if (!state.streamDest) state.streamDest = state.ctx.createMediaStreamDestination();
    outputMerge.connect(state.streamDest);
    state.outputMerge = outputMerge;
    audio.srcObject = state.streamDest.stream;
    state.worklet = worklet;
    state.musicSrc = musicSrc;
    state.clickSrc = clickSrc;
    postPitch();
    const when = state.ctx.currentTime + 0.05;
    musicSrc.start(when, state.offset);
    clickSrc.start(when, state.offset);
    state.startedAt = when;
    state.playing = true;
    $("play").textContent = "Pausa";
    await audio.play();
    updateMediaSession();
  }

  async function rebuild(keepPlaying) {
    if (!state.song || state.building) {
      state.dirty = true;
      return;
    }
    state.building = true;
    state.dirty = false;
    const wasPlaying = keepPlaying && state.playing;
    const where = Math.max(0, engineFileTime());
    setStatus("Preparo i canali. Il click resta solo sulla sua uscita.");
    try {
      const plan = mixApi.planRehearsal(state.song.beats, state.leadBars, state.invert);
      const music = musicBuffer();
      const total = Math.max(1, Math.round(plan.duration * 44100));
      const musicFull = new Float32Array(total);
      const start = Math.round(plan.musicStart * 44100);
      const count = Math.min(music.length, total - start);
      if (count > 0) musicFull.set(music.subarray(0, count), start);
      state.musicSamples = musicFull;
      state.clickSamples = mixApi.synthesizeClicks(plan.duration, plan.hits, state.clickVolume, 44100);
      state.leadSeconds = plan.leadSeconds;
      state.ready = true;
      const side = state.invert ? "destro" : "sinistro";
      const musicSide = state.invert ? "sinistro" : "destro";
      setStatus("Click sul canale " + side + ". Musica, in mono, sul canale " + musicSide + ".");
      if (wasPlaying) await startAt(where < 0.05 ? 0 : where);
    } catch (error) {
      setStatus(error.message || "Non riesco a preparare l'audio.");
    } finally {
      state.building = false;
      if (state.dirty) {
        state.dirty = false;
        rebuild(true);
      }
    }
  }

  let rebuildTimer = 0;
  function scheduleRebuild() {
    state.dirty = true;
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(function () { rebuild(true); }, 280);
  }

  function setPreset(name) {
    state.included = mixApi.PRESETS[name].slice();
    state.invert = false;
    $("invert").checked = false;
    buildStemRows();
    scheduleRebuild();
  }

  async function filesFromZip(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const table = await unzipApi.unzip(bytes);
    return table;
  }

  function recordFromFiles(table) {
    const manifestBytes = table["manifest.json"];
    const beatsBytes = table["battiti.json"];
    if (!manifestBytes || !beatsBytes) {
      throw new Error("Nel pacchetto servono manifest.json e battiti.json.");
    }
    const manifest = JSON.parse(new TextDecoder("utf-8").decode(manifestBytes));
    const beats = JSON.parse(new TextDecoder("utf-8").decode(beatsBytes));
    beatApi.validatePack(manifest, beats);
    const files = {};
    manifest.stems.forEach(function (stem) {
      const raw = table[stem.file];
      if (!raw) throw new Error("Manca " + stem.file + ".");
      files[stem.file] = new Blob([raw], { type: "audio/mpeg" });
    });
    return {
      id: (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()),
      title: manifest.title,
      created: Date.now(),
      manifest: manifest,
      beats: beats,
      files: files,
      semitones: typeof manifest.semitones === "number" ? manifest.semitones : 0,
    };
  }

  async function remember(record) {
    try {
      await idbPut(record);
    } catch (error) {
      throw new Error("Il telefono non ha spazio abbastanza per questo brano.");
    }
    await refreshList();
  }

  async function refreshList() {
    const list = $("saved");
    list.innerHTML = "";
    let rows = [];
    try { rows = await idbAll(); } catch (error) { return; }
    rows.sort(function (a, b) { return b.created - a.created; });
    if (!rows.length) {
      list.innerHTML = "<p class='hint'>Nessun brano salvato su questo telefono.</p>";
      return;
    }
    rows.forEach(function (row) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "saved";
      button.textContent = row.title;
      button.addEventListener("click", function () { openRecord(row); });
      list.appendChild(button);
    });
  }

  async function openRecord(record) {
    setStatus("Leggo le tracce salvate sul telefono.");
    try {
      await prepareSong(record);
    } catch (error) {
      setStatus(error.message || "Non riesco ad aprire il brano.");
    }
  }

  async function onZip(file) {
    setStatus("Apro il pacchetto.");
    try {
      const table = await filesFromZip(file);
      const record = recordFromFiles(table);
      await remember(record);
      await openRecord(record);
    } catch (error) {
      setStatus(error.message || "Pacchetto illeggibile.");
    }
  }

  async function onFolder(fileList) {
    const table = {};
    for (let i = 0; i < fileList.length; i += 1) {
      const file = fileList[i];
      const name = (file.webkitRelativePath || file.name).split("/").pop();
      table[name] = new Uint8Array(await file.arrayBuffer());
    }
    try {
      const record = recordFromFiles(table);
      await remember(record);
      await openRecord(record);
    } catch (error) {
      setStatus(error.message || "Cartella incompleta.");
    }
  }

  function updateMediaSession() {
    if (!("mediaSession" in navigator) || !state.song) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: state.song.manifest.title,
      artist: "Cambia Genere",
      album: "Sala prove",
    });
    navigator.mediaSession.setActionHandler("play", function () { audio.play(); });
    navigator.mediaSession.setActionHandler("pause", function () { audio.pause(); });
    try {
      navigator.mediaSession.setActionHandler("seekto", function (details) {
        if (typeof details.seekTime === "number") audio.currentTime = details.seekTime;
      });
    } catch (error) { /* alcuni browser non hanno seekto */ }
  }

  $("zip").addEventListener("change", function () {
    const file = $("zip").files && $("zip").files[0];
    if (file) onZip(file);
  });
  $("folder").addEventListener("change", function () {
    if ($("folder").files && $("folder").files.length) onFolder($("folder").files);
  });
  $("pick-zip").addEventListener("click", function () { $("zip").click(); });
  $("pick-folder").addEventListener("click", function () { $("folder").click(); });

  $("play").addEventListener("click", async function () {
    unlockAudio();
    if (!state.ready) {
      setStatus("Apri prima un pacchetto.");
      return;
    }
    if (!state.playing) {
      const atStart = songTime() < 0.12 && state.leadSeconds > 0;
      try {
        await startAt(atStart ? 0 : Math.max(0, engineFileTime()));
      } catch (error) {
        setStatus(error.message || "Il telefono ha bloccato l'audio. Premi di nuovo play.");
      }
    } else {
      stopSources();
    }
  });

  $("seek").addEventListener("pointerdown", function () { state.seeking = true; });
  $("seek").addEventListener("input", function () {
    state.seeking = true;
    state.offset = fileTimeForSong(Number($("seek").value));
    if (!state.playing) renderBeatFace();
  });
  $("seek").addEventListener("change", function () {
    state.seeking = false;
    const target = fileTimeForSong(Number($("seek").value));
    if (state.playing) startAt(target);
    else state.offset = target;
  });

  $("speed").addEventListener("change", function () {
    const position = engineFileTime();
    state.speed = Number($("speed").value);
    state.offset = position;
    if (state.ctx) state.startedAt = state.ctx.currentTime;
    if (state.musicSrc) state.musicSrc.playbackRate.value = state.speed;
    if (state.clickSrc) state.clickSrc.playbackRate.value = state.speed;
    postPitch();
    applySpeed();
  });

  function changeTone(delta) {
    state.semitones = Math.max(-6, Math.min(6, state.semitones + delta));
    showTone();
    postPitch();
    if (state.song) {
      state.song.semitones = state.semitones;
      idbPut(state.song).catch(function () {});
    }
  }
  $("tone-down").addEventListener("click", function () { changeTone(-1); });
  $("tone-up").addEventListener("click", function () { changeTone(1); });
  $("lead").addEventListener("change", function () {
    state.leadBars = Number($("lead").value);
    scheduleRebuild();
  });
  $("invert").addEventListener("change", function () {
    state.invert = $("invert").checked;
    scheduleRebuild();
  });
  $("click-volume").addEventListener("input", function () {
    state.clickVolume = Number($("click-volume").value);
    scheduleRebuild();
  });
  $("music-volume").addEventListener("input", function () {
    state.musicVolume = Number($("music-volume").value);
    scheduleRebuild();
  });
  $("preset-routing").addEventListener("click", function () {
    state.invert = false;
    $("invert").checked = false;
    scheduleRebuild();
  });
  $("only-voice").addEventListener("click", function () { setPreset("voce"); });
  $("only-base").addEventListener("click", function () { setPreset("base"); });
  $("all-stems").addEventListener("click", function () { setPreset("tutto"); });

  $("mark-a").addEventListener("click", function () {
    state.loopA = Math.max(0, songTime());
    $("loop-label").textContent = "A " + beatApi.formatClock(state.loopA) + (state.loopB == null ? "" : " · B " + beatApi.formatClock(state.loopB));
  });
  $("mark-b").addEventListener("click", function () {
    state.loopB = Math.max(0, songTime());
    $("loop-label").textContent = "A " + beatApi.formatClock(state.loopA) + " · B " + beatApi.formatClock(state.loopB);
  });
  $("loop").addEventListener("change", function () {
    state.loopOn = $("loop").checked;
    if (state.loopOn && (state.loopB == null || state.loopB <= state.loopA)) {
      setStatus("Segna prima l'inizio e la fine del pezzo da ripetere.");
      $("loop").checked = false;
      state.loopOn = false;
    }
  });

  $("wake").addEventListener("change", async function () {
    if (!$("wake").checked) {
      if (state.wakeLock) state.wakeLock.release();
      state.wakeLock = null;
      return;
    }
    try {
      state.wakeLock = await navigator.wakeLock.request("screen");
    } catch (error) {
      $("wake").checked = false;
      setStatus("Questo telefono non tiene lo schermo acceso da questa pagina.");
    }
  });

  $("remove").addEventListener("click", async function () {
    if (!state.song) return;
    if (!confirm("Tolgo questo brano dal telefono?")) return;
    await idbDelete(state.song.id);
    audio.pause();
    state.song = null;
    $("player").hidden = true;
    await refreshList();
    setStatus("Brano tolto da questo telefono.");
  });

  document.addEventListener("visibilitychange", function () {
    /* Non mettere in pausa: a schermo spento l'audio deve continuare. */
    if (document.visibilityState === "visible" && state.playing && audio.paused) {
      audio.play().catch(function () {});
    }
  });

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./sw.js").catch(function () {});
  }

  function onlineNote() {
    $("net").textContent = navigator.onLine
      ? "Sei in rete. Dopo questa apertura il player resta sul telefono."
      : "Modalità senza rete: i brani già salvati si aprono lo stesso.";
  }
  window.addEventListener("online", onlineNote);
  window.addEventListener("offline", onlineNote);
  onlineNote();
  refreshList();
  setInterval(function () {
    if (state.playing) {
      loopWatch();
      renderBeatFace();
    }
  }, 80);
})();
