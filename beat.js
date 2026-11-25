/* Battiti, orologio e controllo del pacchetto. Funziona nel browser e in Node. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CambiaBeat = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function findBeatIndex(beats, time) {
    let lo = 0;
    let hi = beats.length - 1;
    let answer = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (beats[mid].time <= time + 0.03) {
        answer = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return answer;
  }

  function upcomingBeats(beats, from, to) {
    const out = [];
    for (let i = 0; i < beats.length; i += 1) {
      const t = beats[i].time;
      if (t <= from) continue;
      if (t > to) break;
      out.push(beats[i]);
    }
    return out;
  }

  function formatClock(seconds) {
    const whole = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(whole / 60);
    const secs = String(whole % 60).padStart(2, "0");
    return minutes + ":" + secs;
  }

  function sectionAt(sections, time) {
    if (!sections) return null;
    for (let i = 0; i < sections.length; i += 1) {
      const section = sections[i];
      if (time >= section.start && time <= section.end + 0.05) return section;
    }
    return sections.length ? sections[sections.length - 1] : null;
  }

  function validatePack(manifest, beats) {
    if (!manifest || manifest.format !== "cambia-genere-player" || manifest.version !== 1) {
      throw new Error("Questo pacchetto non è di Cambia Genere, oppure è di una versione che non leggo.");
    }
    if (!manifest.title || !Array.isArray(manifest.stems) || manifest.stems.length < 1) {
      throw new Error("Nel pacchetto mancano le tracce.");
    }
    manifest.stems.forEach(function (stem) {
      if (!stem.id || !stem.file || !stem.label) {
        throw new Error("Una traccia del pacchetto è incompleta.");
      }
    });
    if (!beats || !Array.isArray(beats.beats) || beats.beats.length < 2) {
      throw new Error("Nel pacchetto non trovo la mappa dei battiti.");
    }
    const beat = beats.beats[0];
    if (typeof beat.time !== "number" || typeof beat.downbeat !== "boolean") {
      throw new Error("La mappa dei battiti non ha i primi tempi.");
    }
    return true;
  }

  return {
    findBeatIndex: findBeatIndex,
    upcomingBeats: upcomingBeats,
    formatClock: formatClock,
    sectionAt: sectionAt,
    validatePack: validatePack,
  };
});
