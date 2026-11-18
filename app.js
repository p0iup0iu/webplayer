/* SONORA — local MP3 / M4A player with reactive visualizer */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const els = {
    canvas: $("viz"), cover: $("cover"), coverWrap: $("coverWrap"),
    coverFallback: $("coverFallback"), trackList: $("trackList"),
    trackCount: $("trackCount"), addBtn: $("addBtn"), fileInput: $("fileInput"),
    dropOverlay: $("dropOverlay"), statusPill: $("statusPill"), statusText: $("statusText"),
    trackTitle: $("trackTitle"), trackArtist: $("trackArtist"),
    tagFmt: $("tagFmt"), tagRate: $("tagRate"), tagTime: $("tagTime"),
    prevBtn: $("prevBtn"), playBtn: $("playBtn"), nextBtn: $("nextBtn"),
    progress: $("progress"), progressFill: $("progressFill"), progressThumb: $("progressThumb"),
    elapsed: $("elapsed"), duration: $("duration"),
    shuffleBtn: $("shuffleBtn"), repeatBtn: $("repeatBtn"),
    muteBtn: $("muteBtn"), volume: $("volume"), toast: $("toast"),
  };

  const audio = new Audio();
  audio.preload = "metadata";
  audio.crossOrigin = "anonymous";

  const emptyMeta = () => ({ title: "", artist: "", album: "", genre: "" });

  const state = {
    tracks: [], index: -1, playing: false, offset: 0,
    volume: 0.78, muted: false, shuffle: false, repeat: false,
    ctx: null, analyser: null, freq: null, td: null, gain: null, useGain: false,
    bass: 0,
  };

  let toastTimer = 0;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2600);
  }

  const fmtTime = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60), r = Math.floor(s % 60);
    return m + ":" + String(r).padStart(2, "0");
  };

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /* ============================================================
     Metadata: ID3v2 (MP3) + iTunes "ilst" atoms (M4A/MP4)
     ============================================================ */

  let _dec = null;
  function decoders() {
    if (_dec) return _dec;
    _dec = {
      lat: new TextDecoder("windows-1252"),
      utf8: new TextDecoder("utf-8"),
      le: new TextDecoder("utf-16le"),
      be: new TextDecoder("utf-16be"),
    };
    return _dec;
  }

  function cleanText(s) {
    if (!s) return "";
    const z = s.indexOf("\u0000");
    if (z >= 0) s = s.slice(0, z);
    return s.replace(/^\uFEFF/, "").trim();
  }

  /* ---- ID3v2 text frame (honours the encoding byte) ---- */
  function id3Text(buf, ds, size) {
    if (size <= 0) return "";
    const enc = buf[ds];
    const sub = buf.subarray(ds + 1, ds + size);
    try {
      const d = decoders();
      let s;
      if (enc === 1) {
        if (sub.length >= 2 && sub[0] === 0xFE && sub[1] === 0xFF) s = d.be.decode(sub);
        else s = d.le.decode(sub);
      } else if (enc === 2) s = d.be.decode(sub);
      else if (enc === 0) s = d.lat.decode(sub);
      else s = d.utf8.decode(sub);
      return cleanText(s);
    } catch (e) {
      let s = "";
      for (let i = 0; i < sub.length && sub[i]; i++) s += String.fromCharCode(sub[i]);
      return s.trim();
    }
  }

  /* ---- ID3 APIC picture frame ---- */
  function id3Art(buf, ds, size) {
    if (size <= 0) return null;
    const enc = buf[ds];
    const end = ds + size;
    let i = ds + 1;
    let mime = "";
    while (i < end && buf[i] !== 0) { mime += String.fromCharCode(buf[i]); i++; }
    i++; // mime terminator
    // description (UTF-16 uses a double-zero terminator)
    if (enc === 1 || enc === 2) {
      while (i + 1 < end && !(buf[i] === 0 && buf[i + 1] === 0)) i += 2;
      i += 2;
    } else {
      while (i < end && buf[i] !== 0) i++;
      i++;
    }
    if (i >= end) return null;
    return { mime: mime || "image/jpeg", data: buf.subarray(i, end) };
  }

  function parseId3(buf) {
    const out = { meta: emptyMeta(), art: null };
    if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return out;

    const major = buf[3];
    const flags = buf[5];
    const tagSize =
      ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) |
      ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    let p = 10;
    const end = Math.min(buf.length, 10 + tagSize);

    // extended header
    if (flags & 0x40) {
      if (major >= 4) {
        const eh = ((buf[p] & 0x7f) << 21) | ((buf[p + 1] & 0x7f) << 14) |
                   ((buf[p + 2] & 0x7f) << 7) | (buf[p + 3] & 0x7f);
        p += eh;
      } else {
        const eh = (buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3];
        p += eh + 4;
      }
    }

    while (p + 10 <= end) {
      const id = String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;

      let fsize;
      if (major >= 4) {
        fsize = ((buf[p + 4] & 0x7f) << 21) | ((buf[p + 5] & 0x7f) << 14) |
                ((buf[p + 6] & 0x7f) << 7) | (buf[p + 7] & 0x7f);
      } else {
        fsize = (buf[p + 4] << 24) | (buf[p + 5] << 16) | (buf[p + 6] << 8) | buf[p + 7];
      }
      if (fsize <= 0 || p + 10 + fsize > end) break;

      const ds = p + 10;
      if (id === "TIT2") out.meta.title = id3Text(buf, ds, fsize);
      else if (id === "TPE1") out.meta.artist = id3Text(buf, ds, fsize);
      else if (id === "TALB") out.meta.album = id3Text(buf, ds, fsize);
      else if (id === "TCON") out.meta.genre = id3Text(buf, ds, fsize);
      else if (id === "TPE2" && !out.meta.artist) out.meta.artist = id3Text(buf, ds, fsize);
      else if (id === "APIC" && !out.art) out.art = id3Art(buf, ds, fsize);

      p = ds + fsize;
    }
    return out;
  }

  /* ---- MP4 / M4A atom tree ---- */
  function parseMp4(buf) {
    const out = { meta: emptyMeta(), art: null };
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const typeAt = (p) => String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]);

    function children(start, end) {
      const list = [];
      let p = start;
      while (p + 8 <= end) {
        let size = dv.getUint32(p);
        const type = typeAt(p + 4);
        let header = 8;
        if (size === 1) {
          const hi = dv.getUint32(p + 8);
          const lo = dv.getUint32(p + 12);
          size = hi * 4294967296 + lo;
          header = 16;
        } else if (size === 0) {
          size = end - p;
        }
        if (size < header || p + size > end) break;
        list.push({ type: type, data: p + header, end: p + size });
        p += size;
      }
      return list;
    }

    const top = children(0, buf.length);
    const moov = top.find((a) => a.type === "moov");
    if (!moov) return out;
    const udta = children(moov.data, moov.end).find((a) => a.type === "udta");
    let meta = udta ? children(udta.data, udta.end).find((a) => a.type === "meta") : null;
    if (!meta) meta = children(moov.data, moov.end).find((a) => a.type === "meta");
    if (!meta) return out;
    // "meta" is a full box: 4 bytes version/flags precede its children
    const ilst = children(meta.data + 4, meta.end).find((a) => a.type === "ilst");
    if (!ilst) return out;

    const d = decoders();
    for (const tag of children(ilst.data, ilst.end)) {
      const data = children(tag.data, tag.end).find((a) => a.type === "data");
      if (!data) continue;
      const payload = buf.subarray(data.data + 8, data.end); // skip type + locale

      if (tag.type === "covr") {
        if (!out.art && payload.length) {
          const kind = dv.getUint32(data.data);
          out.art = { mime: kind === 14 ? "image/png" : "image/jpeg", data: payload };
        }
        continue;
      }

      let key = null;
      if (tag.type === "\u00A9nam") key = "title";
      else if (tag.type === "\u00A9ART") key = "artist";
      else if (tag.type === "\u00A9alb") key = "album";
      else if (tag.type === "\u00A9gen") key = "genre";
      else if (tag.type === "aART" && !out.meta.artist) key = "artist";
      if (!key) continue;

      let text = "";
      try { text = d.utf8.decode(payload); } catch (e) { text = ""; }
      text = cleanText(text);
      if (text) out.meta[key] = text;
    }
    return out;
  }

  function readMeta(file) {
    return file.arrayBuffer().then((ab) => {
      const buf = new Uint8Array(ab);
      const isMp4 = buf.length >= 12 &&
        buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70; // "ftyp"
      const r = isMp4 ? parseMp4(buf) : parseId3(buf);
      return { meta: r.meta, art: r.art || null };
    }).catch(() => ({ meta: emptyMeta(), art: null }));
  }

  /* ============================================================
     Audio graph (native <audio> -> MediaElementSource -> analyser)
     ============================================================ */

  function ensureGraph() {
    if (state.ctx) return state.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { state.useGain = false; return null; }

    const ctx = new AC();
    state.ctx = ctx;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.8;
    analyser.minDecibels = -95;
    analyser.maxDecibels = -10;
    state.analyser = analyser;
    state.freq = new Uint8Array(analyser.frequencyBinCount);
    state.td = new Uint8Array(analyser.fftSize);

    const gain = ctx.createGain();
    gain.gain.value = state.muted ? 0 : state.volume;
    state.gain = gain;

    try {
      const src = ctx.createMediaElementSource(audio);
      src.connect(gain);
      gain.connect(analyser);
      analyser.connect(ctx.destination);
      state.useGain = true;
      audio.volume = 1; // volume handled by the gain node
    } catch (e) {
      // Browser refused MediaElementSource: play straight from the element.
      state.useGain = false;
      audio.volume = state.muted ? 0 : state.volume;
    }
    return ctx;
  }

  function resumeCtx() {
    if (state.ctx && state.ctx.state === "suspended") state.ctx.resume().catch(() => {});
  }

  function applyVolume() {
    const v = state.muted ? 0 : state.volume;
    if (state.useGain && state.gain && state.ctx) {
      state.gain.gain.setTargetAtTime(v, state.ctx.currentTime, 0.02);
    } else {
      audio.volume = v;
    }
  }

  function setVolume(v) {
    state.volume = Math.max(0, Math.min(1, v));
    els.volume.value = Math.round(state.volume * 100);
    applyVolume();
  }

  function updateMuteIcon() {
    const on = els.muteBtn.querySelector(".ico-sound");
    const off = els.muteBtn.querySelector(".ico-muted");
    if (on) on.hidden = state.muted;
    if (off) off.hidden = !state.muted;
  }

  function setPlayingUI(on) {
    state.playing = on;
    els.playBtn.classList.toggle("playing", on);
    els.statusPill.classList.toggle("on", on);
    els.statusText.textContent = on ? "PLAYING" : (state.index >= 0 ? "PAUSED" : "IDLE");
  }

  function syncProgress() {
    const t = state.tracks[state.index];
    const d = (t && t.duration) || (isFinite(audio.duration) ? audio.duration : 0);
    const cur = audio.currentTime || 0;
    state.offset = cur;
    const p = d > 0 ? Math.min(1, cur / d) : 0;
    els.progressFill.style.width = (p * 100) + "%";
    els.progressThumb.style.left = (p * 100) + "%";
    els.elapsed.textContent = fmtTime(cur);
    els.tagTime.textContent = fmtTime(cur);
    if (d > 0) els.duration.textContent = fmtTime(d);
  }

  /* ============================================================
     Loading
     ============================================================ */

  function loadTrack(file) {
    const track = {
      id: (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "t" + Date.now() + Math.random()),
      name: file.name,
      file: file,
      url: URL.createObjectURL(file),
      duration: 0,
      meta: emptyMeta(),
      art: null,
    };
    state.tracks.push(track);
    renderPlaylist();

    readMeta(file).then((r) => {
      track.meta = r.meta;
      track.art = r.art;
      renderPlaylist();
      if (state.tracks[state.index] === track) renderCurrent();
    }).catch(() => {});

    return track;
  }

  function addFiles(list) {
    const files = Array.from(list || []).filter((f) =>
      (f.type && f.type.indexOf("audio/") === 0) ||
      /\.(mp3|m4a|mp4|aac|ogg|oga|opus|flac|wav|aiff?|wma|webm)$/i.test(f.name)
    );
    if (!files.length) { toast("No audio files found"); return; }

    const wasPlaying = state.playing;
    const firstNew = state.tracks.length;
    files.forEach((f) => loadTrack(f));

    if (!wasPlaying) {
      state.index = firstNew;
      state.offset = 0;
      renderCurrent();
      play();
    }
    toast(files.length + (files.length === 1 ? " track added" : " tracks added"));
  }

  /* ============================================================
     Playlist + stage rendering
     ============================================================ */

  function renderPlaylist() {
    els.trackCount.textContent = state.tracks.length + " TRACK" + (state.tracks.length === 1 ? "" : "S");
    els.trackList.innerHTML = "";
    state.tracks.forEach((t, i) => {
      const li = document.createElement("li");
      li.className = "track-item" + (i === state.index ? " active" : "");
      li.innerHTML =
        '<span class="track-num">' + String(i + 1).padStart(2, "0") + "</span>" +
        '<span class="track-name"></span>' +
        '<span class="track-dur"></span>' +
        '<button class="track-x" title="Remove"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
      li.querySelector(".track-name").textContent = t.meta.title || t.name;
      li.querySelector(".track-dur").textContent = t.duration ? fmtTime(t.duration) : "--:--";
      li.addEventListener("click", () => select(i));
      li.querySelector(".track-x").addEventListener("click", (ev) => {
        ev.stopPropagation();
        removeTrack(i);
      });
      els.trackList.appendChild(li);
    });
  }

  function setDuration(d) {
    els.duration.textContent = fmtTime(d || 0);
  }

  function renderCurrent() {
    const t = state.tracks[state.index];
    if (!t) { resetStage(); return; }

    els.coverWrap.classList.add("has-track");
    els.coverFallback.style.display = "none";
    drawCover(t);
    if (t.art) drawAlbumArt(t);

    const c1 = t.c1 || COVERS[0][0];
    const c2 = t.c2 || COVERS[0][1];
    els.coverWrap.style.background =
      "radial-gradient(circle at 30% 25%, " + c1 + ", transparent 60%), " + c2;

    els.trackTitle.textContent = t.meta.title || t.name.replace(/\.[^.]+$/, "");
    els.trackArtist.textContent = t.meta.artist || ("LOCAL FILE · " + t.file.name);
    els.tagFmt.textContent = t.meta.album ||
      (t.file.type ? t.file.type.replace("audio/", "").toUpperCase() : "AUDIO");
    els.tagRate.textContent = (t.meta.genre || "NO GENRE") + " · " + fmtTime(t.duration) + " DUR";
    els.tagTime.textContent = "0:00";
    els.elapsed.textContent = "0:00";
    els.progressFill.style.width = "0%";
    els.progressThumb.style.left = "0%";
    setDuration(t.duration);
    renderPlaylist();
  }

  function resetStage() {
    els.coverWrap.classList.remove("has-track");
    els.coverWrap.style.background = "";
    els.coverFallback.style.display = "";
    els.trackTitle.textContent = "Nothing playing";
    els.trackArtist.textContent = "Add music to start";
    els.tagFmt.textContent = "—";
    els.tagRate.textContent = "—";
    els.tagTime.textContent = "0:00";
    els.elapsed.textContent = "0:00";
    els.duration.textContent = "0:00";
    els.progressFill.style.width = "0%";
    els.progressThumb.style.left = "0%";
  }

  function removeTrack(i) {
    const t = state.tracks[i];
    if (!t) return;
    const wasCurrent = i === state.index;

    if (wasCurrent) {
      audio.pause();
      try { audio.removeAttribute("src"); audio.load(); } catch (e) {}
      setPlayingUI(false);
    }

    URL.revokeObjectURL(t.url);
    state.tracks.splice(i, 1);

    if (i < state.index) {
      state.index--;
    } else if (wasCurrent) {
      state.index = state.tracks.length ? Math.min(i, state.tracks.length - 1) : -1;
      state.offset = 0;
    }

    if (!state.tracks.length) {
      state.index = -1;
      resetStage();
    } else if (state.tracks[state.index]) {
      renderCurrent();
    }
    renderPlaylist();
  }

  /* ============================================================
     Transport
     ============================================================ */

  function select(i) {
    if (i < 0 || i >= state.tracks.length) return;
    if (i === state.index && audio.src) { togglePlay(); return; }

    const wasPlaying = state.playing;
    state.index = i;
    state.offset = 0;
    const t = state.tracks[i];
    audio.src = t.url;
    audio.load();
    renderCurrent();
    if (wasPlaying) play();
  }

  function play() {
    if (!state.tracks.length) { toast("Add music first"); return; }
    if (state.index < 0) { state.index = 0; renderCurrent(); }

    const t = state.tracks[state.index];
    if (!t) return;

    ensureGraph();
    resumeCtx();

    if (audio.src !== t.url) {
      audio.src = t.url;
      audio.load();
    } else if (audio.ended) {
      state.offset = 0;
    }

    // Seek to the saved offset once the media knows its timeline.
    if (state.offset > 0) {
      const seek = () => { try { audio.currentTime = state.offset; } catch (e) {} };
      if (audio.readyState >= 1) seek();
      else audio.addEventListener("loadedmetadata", seek, { once: true });
    }

    // Call play() synchronously so it stays inside the user gesture.
    audio.play().then(() => setPlayingUI(true)).catch((err) => {
      toast("Could not play that file" + (err && err.name === "NotAllowedError" ? " — tap play" : ""));
    });
  }

  function pause() {
    state.offset = audio.currentTime || 0;
    audio.pause();
    setPlayingUI(false);
  }

  function togglePlay() {
    if (!state.tracks.length) { toast("Add music first"); return; }
    if (state.index < 0) { state.index = 0; renderCurrent(); play(); return; }
    if (audio.paused) play(); else pause();
  }

  function next() {
    if (!state.tracks.length) return;
    let i = state.index + 1;
    if (state.shuffle && state.tracks.length > 1) {
      do { i = Math.floor(Math.random() * state.tracks.length); } while (i === state.index);
    }
    if (i >= state.tracks.length) {
      if (state.repeat) { state.offset = 0; audio.currentTime = 0; play(); return; }
      state.index = -1;
      state.offset = 0;
      audio.pause();
      try { audio.removeAttribute("src"); audio.load(); } catch (e) {}
      setPlayingUI(false);
      renderPlaylist();
      return;
    }
    select(i);
  }

  function prev() {
    if (audio.currentTime > 3) { state.offset = 0; audio.currentTime = 0; return; }
    if (state.index > 0) select(state.index - 1);
    else { state.offset = 0; audio.currentTime = 0; play(); }
  }

  function toggleShuffle() {
    state.shuffle = !state.shuffle;
    els.shuffleBtn.classList.toggle("active", state.shuffle);
    toast(state.shuffle ? "SHUFFLE ON" : "SHUFFLE OFF");
  }

  function toggleRepeat() {
    state.repeat = !state.repeat;
    els.repeatBtn.classList.toggle("active", state.repeat);
    toast(state.repeat ? "REPEAT ON" : "REPEAT OFF");
  }

  function toggleMute() {
    state.muted = !state.muted;
    updateMuteIcon();
    applyVolume();
  }

  /* ============================================================
     Procedural cover art
     ============================================================ */

  const COVERS = [
    ["#FF7A18", "#1B0F06", "#FFC9A0"],
    ["#FF3B30", "#160A0B", "#FFB4A8"],
    ["#6E5CFF", "#0B0A1E", "#C9BEFF"],
    ["#21C07A", "#06150F", "#CFF7E6"],
    ["#F5D000", "#1A1500", "#FFF0A8"],
    ["#00D2FF", "#04151F", "#E4FBFF"],
    ["#FF5FA2", "#1A0712", "#FFD3E4"],
    ["#8A6DFF", "#120C20", "#D9C7FF"],
  ];

  function drawCover(t) {
    const cv = els.cover;
    const c = cv.getContext("2d");
    const W = cv.width, H = cv.height;
    const p = COVERS[hash(t.name) % COVERS.length];
    t.c1 = p[0];
    t.c2 = p[1];

    c.clearRect(0, 0, W, H);
    const g = c.createRadialGradient(W * 0.35, H * 0.3, 20, W * 0.5, H * 0.5, W * 0.72);
    g.addColorStop(0, p[2]);
    g.addColorStop(0.45, p[0]);
    g.addColorStop(1, p[1]);
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);

    c.save();
    c.globalCompositeOperation = "soft-light";
    const rg = c.createRadialGradient(W * 0.5, H * 0.5, 0, W * 0.5, H * 0.5, W * 0.5);
    rg.addColorStop(0, "rgba(255,255,255,.35)");
    rg.addColorStop(1, "rgba(0,0,0,.5)");
    c.fillStyle = rg;
    c.fillRect(0, 0, W, H);
    c.restore();

    c.strokeStyle = "rgba(255,255,255,.10)";
    c.lineWidth = 1.5;
    for (let r = 60; r < W * 0.44; r += 46) {
      c.beginPath();
      c.arc(W * 0.5, H * 0.5, r, 0, Math.PI * 2);
      c.stroke();
    }
    c.strokeStyle = "rgba(255,255,255,.14)";
    c.beginPath();
    c.arc(W * 0.5, H * 0.5, W * 0.42, -0.9, 0.9);
    c.stroke();

    c.save();
    c.translate(W * 0.5, H * 0.5);
    c.rotate(-0.28);
    c.fillStyle = "rgba(255,255,255,.16)";
    c.fillRect(-W * 0.36, -H * 0.02, W * 0.72, H * 0.04);
    c.restore();

    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillStyle = "rgba(255,255,255,.94)";
    c.font = '700 ' + Math.round(W * 0.115) + 'px "Fraunces", Georgia, serif';
    const title = (t.meta && t.meta.title) || t.name.replace(/\.[^.]+$/, "");
    c.fillText(title.slice(0, 26), W * 0.5, H * 0.60);

    c.fillStyle = "rgba(255,255,255,.6)";
    c.font = '500 ' + Math.round(W * 0.036) + 'px "IBM Plex Mono", monospace';
    c.fillText("SONORA", W * 0.5, H * 0.69);

    c.fillStyle = "rgba(255,255,255,.35)";
    c.font = '400 ' + Math.round(W * 0.026) + 'px "IBM Plex Mono", monospace';
    c.fillText("LOCAL · " + fmtTime(t.duration), W * 0.5, H * 0.75);
  }

  function drawAlbumArt(t) {
    if (!t.art || !t.art.data || !t.art.data.length) return;
    const cv = els.cover;
    const c = cv.getContext("2d");
    const blob = new Blob([t.art.data], { type: t.art.mime || "image/jpeg" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const pad = Math.round(cv.width * 0.045);
      const s = Math.min((cv.width - pad * 2) / img.width, (cv.height - pad * 2) / img.height);
      const w = img.width * s, h = img.height * s;
      c.save();
      c.fillStyle = "#0A0A0C";
      c.fillRect(0, 0, cv.width, cv.height);
      c.drawImage(img, (cv.width - w) / 2, (cv.height - h) / 2, w, h);
      c.restore();
      URL.revokeObjectURL(url);
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  /* ============================================================
     Visualizer
     ============================================================ */

  const ctx2d = els.canvas.getContext("2d");
  let W = 0, H = 0, DPR = 1;
  const N = 44;
  const parts = [];
  for (let i = 0; i < 46; i++) {
    parts.push({
      a: Math.random() * Math.PI * 2,
      r: 0.12 + Math.random() * 0.34,
      s: 0.00035 + Math.random() * 0.0009,
      z: Math.random() * 1.2,
      o: 0.15 + Math.random() * 0.4,
    });
  }

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    els.canvas.width = W * DPR;
    els.canvas.height = H * DPR;
    els.canvas.style.width = W + "px";
    els.canvas.style.height = H + "px";
    ctx2d.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  function drawGrid() {
    ctx2d.save();
    ctx2d.strokeStyle = "rgba(255,255,255,0.028)";
    ctx2d.lineWidth = 1;
    const s = 64;
    for (let x = (W / 2) % s; x < W; x += s) {
      ctx2d.beginPath(); ctx2d.moveTo(x, 0); ctx2d.lineTo(x, H); ctx2d.stroke();
    }
    for (let y = (H / 2) % s; y < H; y += s) {
      ctx2d.beginPath(); ctx2d.moveTo(0, y); ctx2d.lineTo(W, y); ctx2d.stroke();
    }
    ctx2d.restore();
  }

  function drawRings(t, bass) {
    const cx = W / 2, cy = H * 0.42;
    const R = Math.min(W, H) * 0.30;
    for (let i = 0; i < 3; i++) {
      ctx2d.beginPath();
      ctx2d.arc(cx, cy, R * (1.06 - i * 0.05) + bass * R * 0.05, 0, Math.PI * 2);
      ctx2d.strokeStyle = "rgba(255,122,24," + (0.05 + (1 - i) * 0.035) + ")";
      ctx2d.lineWidth = 1;
      ctx2d.stroke();
    }
  }

  function roundedBar(x, y, w, h, r) {
    ctx2d.beginPath();
    if (typeof ctx2d.roundRect === "function") {
      ctx2d.roundRect(x, y, w, h, r);
      return;
    }
    r = Math.min(r, w / 2, h / 2);
    ctx2d.moveTo(x + r, y);
    ctx2d.arcTo(x + w, y, x + w, y + h, r);
    ctx2d.arcTo(x + w, y + h, x, y + h, r);
    ctx2d.arcTo(x, y + h, x, y, r);
    ctx2d.arcTo(x, y, x + w, y, r);
    ctx2d.closePath();
  }

  function drawSpectrum(t, bass) {
    const cx = W / 2, cy = H * 0.42;
    const R = Math.min(W, H) * 0.30;
    ctx2d.save();
    ctx2d.translate(cx, cy);
    ctx2d.rotate(-t * 0.012);
    ctx2d.translate(-cx, -cy);

    for (let i = 0; i < N; i++) {
      const idx = Math.floor((i / N) * state.freq.length);
      const mag = state.freq[idx] / 255;
      const len = 12 + Math.pow(mag, 1.7) * R * 0.62 + bass * R * 0.05;
      const a = (i / N) * Math.PI * 2 - Math.PI / 2;
      const w = Math.max(3, R * 0.013);
      const x = cx + Math.cos(a) * len;
      const y = cy + Math.sin(a) * len;
      const h = Math.max(4, len * 0.42);
      roundedBar(x - w / 2, y - h / 2, w, h, w / 2);
      ctx2d.fillStyle = "rgba(255,122,24," + (0.16 + mag * 0.62) + ")";
      ctx2d.fill();
      ctx2d.strokeStyle = "rgba(255,160,85," + (0.25 + mag * 0.55) + ")";
      ctx2d.lineWidth = 1;
      ctx2d.stroke();
    }
    ctx2d.restore();
  }

  function drawWaveform() {
    const an = state.analyser;
    if (!an) return;
    if (!state.td || state.td.length !== an.fftSize) state.td = new Uint8Array(an.fftSize);
    an.getByteTimeDomainData(state.td);

    const cx = W / 2, cy = H * 0.42;
    const R = Math.min(W, H) * 0.30;
    const base = cy + R * 0.94;
    const n = state.td.length;
    const amp = state.playing ? 0.55 : 0.16;

    ctx2d.save();
    ctx2d.beginPath();
    ctx2d.rect(0, base, W, Math.max(0, H - base));
    ctx2d.clip();

    ctx2d.beginPath();
    ctx2d.moveTo(0, base);
    for (let x = 0; x <= W; x++) {
      const i = Math.floor((x / W) * (n - 1));
      const v = Math.abs((state.td[i] - 128) / 128);
      ctx2d.lineTo(x, base + Math.max(1.5, v * R * 0.85 * amp));
    }
    for (let x = W; x >= 0; x -= 1) {
      const i = Math.floor((x / W) * (n - 1));
      const v = Math.abs((state.td[i] - 128) / 128);
      ctx2d.lineTo(x, base - Math.max(1.5, v * R * 0.85 * amp));
    }
    ctx2d.closePath();

    const g = ctx2d.createLinearGradient(0, base, 0, H);
    g.addColorStop(0, "rgba(255,122,24,0)");
    g.addColorStop(0.4, "rgba(255,122,24,0.32)");
    g.addColorStop(1, "rgba(255,122,24,0.82)");
    ctx2d.fillStyle = g;
    ctx2d.fill();
    ctx2d.restore();
  }

  function drawParticles(t, bass) {
    ctx2d.save();
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      p.a += p.s * (1 + bass * 6);
      const r = p.r * (Math.min(W, H) * 0.55) * (1 + bass * 0.06);
      const x = W / 2 + Math.cos(p.a) * r;
      const y = H * 0.42 + Math.sin(p.a) * r;
      const push = bass * r * 0.10;
      const x2 = x + Math.cos(p.a) * push;
      const y2 = y + Math.sin(p.a) * push;
      const d = Math.hypot(x2 - W / 2, y2 - H * 0.42);
      const alpha = p.o * (1 - d / (Math.min(W, H) * 0.55));
      if (alpha <= 0) continue;
      ctx2d.beginPath();
      ctx2d.arc(x2, y2, 1.1 + p.z * 1.4, 0, Math.PI * 2);
      ctx2d.fillStyle = "rgba(255,160,85," + alpha.toFixed(3) + ")";
      ctx2d.fill();
    }
    ctx2d.restore();
  }

  function draw() {
    ctx2d.clearRect(0, 0, W, H);
    drawGrid();
    drawRings(performance.now() / 1000, state.bass);
    drawSpectrum(performance.now() / 1000, state.bass);
    drawWaveform();
    drawParticles(performance.now() / 1000, state.bass);
  }

  function vizLoop() {
    requestAnimationFrame(vizLoop);
    if (state.analyser && state.freq) state.analyser.getByteFrequencyData(state.freq);

    let sum = 0;
    const fl = state.freq ? state.freq.length : 0;
    for (let i = 0; i < fl; i++) sum += state.freq[i];
    const avg = fl ? sum / fl : 0;
    let bass = 0;
    for (let i = 0; i < 8 && i < fl; i++) bass += state.freq[i];
    bass = fl ? (bass / 8) / 255 : 0;
    state.bass = lerp(state.bass, Math.min(1, avg * 1.4 + bass * 1.6), 0.18);
    if (state.bass > 1) state.bass = 1;

    draw();
    if (state.playing) syncProgress();
  }

  /* ============================================================
     Events
     ============================================================ */

  function wire() {
    els.addBtn.addEventListener("click", () => els.fileInput.click());
    els.fileInput.addEventListener("change", (e) => {
      addFiles(e.target.files);
      e.target.value = "";
    });

    els.playBtn.addEventListener("click", togglePlay);
    els.nextBtn.addEventListener("click", next);
    els.prevBtn.addEventListener("click", prev);
    els.shuffleBtn.addEventListener("click", toggleShuffle);
    els.repeatBtn.addEventListener("click", toggleRepeat);
    els.muteBtn.addEventListener("click", toggleMute);

    els.volume.addEventListener("input", (e) => {
      const v = e.target.value / 100;
      if (state.muted && v > 0) { state.muted = false; updateMuteIcon(); }
      setVolume(v);
    });

    els.progress.addEventListener("click", (e) => {
      const t = state.tracks[state.index];
      if (!t) return;
      const r = els.progress.getBoundingClientRect();
      const p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      const d = t.duration || audio.duration || 0;
      if (d > 0) {
        try { audio.currentTime = p * d; } catch (err) {}
        syncProgress();
      }
    });

    // native audio events keep UI + analyser in sync
    audio.addEventListener("play", () => setPlayingUI(true));
    audio.addEventListener("playing", () => setPlayingUI(true));
    audio.addEventListener("pause", () => setPlayingUI(false));
    audio.addEventListener("timeupdate", syncProgress);
    audio.addEventListener("loadedmetadata", () => {
      const t = state.tracks[state.index];
      if (t && isFinite(audio.duration) && audio.duration > 0) {
        t.duration = audio.duration;
        setDuration(t.duration);
        renderPlaylist();
      }
    });
    audio.addEventListener("ended", () => {
      if (state.repeat) { state.offset = 0; audio.currentTime = 0; play(); }
      else next();
    });
    audio.addEventListener("error", () => {
      if (state.index >= 0) toast("Could not play that file");
    });

    let dragDepth = 0;
    window.addEventListener("dragenter", (e) => {
      e.preventDefault();
      dragDepth++;
      els.dropOverlay.classList.add("show");
    });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("dragleave", (e) => {
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) els.dropOverlay.classList.remove("show");
    });
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      dragDepth = 0;
      els.dropOverlay.classList.remove("show");
      addFiles(e.dataTransfer.files);
    });

    window.addEventListener("keydown", (e) => {
      if (e.target.tagName === "INPUT") return;
      const t = state.tracks[state.index];
      if (e.code === "Space") { e.preventDefault(); togglePlay(); }
      else if (e.code === "ArrowRight" && t) {
        e.preventDefault();
        audio.currentTime = Math.min(t.duration || audio.duration || 0, audio.currentTime + 5);
      } else if (e.code === "ArrowLeft" && t) {
        e.preventDefault();
        audio.currentTime = Math.max(0, audio.currentTime - 5);
      } else if (e.code === "ArrowUp") { e.preventDefault(); setVolume(state.volume + 0.05); }
      else if (e.code === "ArrowDown") { e.preventDefault(); setVolume(state.volume - 0.05); }
    });

    window.addEventListener("pointerdown", resumeCtx);
    window.addEventListener("keydown", resumeCtx);
    window.addEventListener("resize", resize);
  }

  function init() {
    resize();
    wire();
    updateMuteIcon();
    setVolume(state.volume);
    state.freq = new Uint8Array(128);
    resetStage();
    vizLoop();
  }

  // Debug hook for automated tests: open the page with ?debug=1
  if (typeof location !== "undefined" && /[?&]debug=1/.test(location.search)) {
    window.__sonora = { state, audio, addFiles, play, pause, select, next, prev, renderCurrent };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
