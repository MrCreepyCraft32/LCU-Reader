(() => {
  'use strict';

  const dec = window.LCUReader;
  let state = null; // decoded LCU
  let currentSeq = null;
  let activeZone = 0; // 0/1/2 = zone, -1 = all zones overlay
  let audioInfo = { linked: false, path: '', files: [], links: {} };

  // Playback DSP state: 3-zone EQ chains + per-channel level tracking.
  let audioEngine = {
    ctx: null,
    buffers: new Map(),        // wave name -> Promise<AudioBuffer>
    zoneSpecs: [],             // zone index -> enabled band params (cached spec, not nodes)
    flatRoute: null,
    eq: true,
    levels: true,
    zoneForBus: { 0: 0, 1: 2 } // phrase output bus -> eqZones index
  };

  const ZONE_COLORS = ['#22d3ee', '#a855f7', '#f59e0b'];
  const ZONE_FS = 48000; // DSP sample rate assumed for response plotting

  const $ = (id) => document.getElementById(id);

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    setupNav();
    setupOpen();
    setupExports();
    setupDrop();
    setupAudioLinks();
    setupPlaybackSettings();
    window.addEventListener('resize', () => {
      if (state && state.eqZones && state.eqZones.length &&
          $('view-eq').classList.contains('active')) {
        drawEQ(state.eqZones, activeZone);
      }
    });
  }

  /* ---------------- Navigation ---------------- */
  function setupNav() {
    $('nav').addEventListener('click', (e) => {
      const btn = e.target.closest('.nav-item');
      if (!btn) return;
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const view = btn.dataset.view;
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      $(`view-${view}`).classList.add('active');
    });
  }

  /* ---------------- File loading ---------------- */
  function setupOpen() {
$('btnOpen').addEventListener('click', async () => {
      if (!window.lcuAPI) return;
      const res = await window.lcuAPI.openFile();
      if (res && res.success) load(res.content, res.filename, res.filePath);
    });

    $('btnSeqPlay').addEventListener('click', () => {
      if (currentSeq) playSequence(currentSeq);
    });
    $('btnSeqStop').addEventListener('click', stopSequencePlayback);
  }

  function load(content, filename, filePath) {
    state = dec.decode(content, filename);
    state.filePath = filePath || null;
    currentSeq = null;
    activeZone = 0;
    stopSequencePlayback();
    audioEngine.buffers = new Map();
    audioEngine.zoneSpecs = [];
    audioEngine.flatRoute = null;
    rebuildLinks();
    updateLinkStatus();
    renderAll();
  }

  function renderAll() {
    renderFilePanel();
    renderOverview();
    renderSequences();
    renderAudio();
    renderPhrases();
    renderRouting();
    renderHardware();
    renderEQ();
    renderRaw();
  }

  function renderFilePanel() {
    $('fileTitle').textContent = state.filename;
    $('filePath').textContent = state.filePath ? state.filePath.trim() : '';
    $('fileMeta').textContent = `${state.metadata.title || 'Unknown'} • Train #${state.metadata.trainId ?? '-'}`;
    $('fileEmpty').classList.add('hidden');
    $('fileLoaded').classList.remove('hidden');
    $('btnExportJSON').disabled = false;
    $('btnExportCSV').disabled = false;
    $('btnExportAUP').disabled = false;
  }

  /* ---------------- Overview ---------------- */
  function renderOverview() {
    const m = state.metadata;
    const stats = [
      { k: 'Version', v: state.version ?? '-', d: 'LCU firmware format' },
      { k: 'Title', v: m.title || 'Unknown', d: 'Soundtrack title' },
      { k: 'Train ID', v: m.trainId ?? '-', d: 'Vehicle id' },
      { k: 'Date', v: m.date || '-', d: 'Compiled' },
      { k: 'Audio Clips', v: state.waves.length, d: 'Section W' },
      { k: 'Phrases', v: Object.keys(state.phrases).length, d: 'Section P' },
      { k: 'Sequences', v: state.sequences.length, d: 'Section S' },
      { k: 'Triggers', v: state.triggers.length, d: 'Section T' },
      { k: 'EQ Registers', v: state.equalizer.length, d: 'Section Q' },
      { k: 'Sections', v: Object.keys(state.rawSections).length, d: 'Raw present' }
    ];
    $('statGrid').innerHTML = stats.map(s =>
      `<div class="stat-card"><div class="k">${s.k}</div><div class="v">${s.v}</div><div class="d">${s.d}</div></div>`
    ).join('');

    const groups = Object.entries(state.groups)
      .map(([id, name]) => `<span>Group ${id}: <b>${escapeHtml(name)}</b></span>`)
      .join('<br>');
    const delays = state.delays.length ? state.delays.join(', ') : 'n/a';
    $('ovSummary').innerHTML = `<div class="summary-block">
      <div class="summary-row"><span class="label">Vehicle</span><span class="value">${escapeHtml(m.vehicleName || '-')} (rel ${escapeHtml(m.vehicleVersion || '-')})</span></div>
      <div class="summary-row"><span class="label">Network</span><span class="value">${escapeHtml(state.network.ip || '-')} / ${escapeHtml(state.network.gateway || '-')} / ${escapeHtml(state.network.subnet || '-')}</span></div>
      <div class="summary-row"><span class="label">Groups</span><span class="value">${groups || '-'}</span></div>
      <div class="summary-row"><span class="label">Delays</span><span class="value">${escapeHtml(delays)}</span></div>
    </div>`;
  }

  /* ---------------- Sequences ---------------- */
  function renderSequences() {
    $('seqList').innerHTML = '';
    state.sequences.forEach(s => {
      const el = document.createElement('div');
      el.className = 'seq-item';
      el.innerHTML = `<span>${s.id}. ${s.name}</span><span class="count">${s.eventCount}</span>`;
      el.addEventListener('click', () => selectSequence(s, el));
      $('seqList').appendChild(el);
    });

    $('seqFilter').oninput = (e) => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll('.seq-item').forEach(el => {
        el.style.display = el.textContent.toLowerCase().includes(q) ? 'flex' : 'none';
      });
    };

    const defaultSeq = state.sequences.find(s => s.id === 20) || state.sequences[0];
    if (defaultSeq) selectSequence(defaultSeq, $('seqList').children[state.sequences.indexOf(defaultSeq)]);
  }

  function selectSequence(seq, itemEl) {
    stopSequencePlayback();
    currentSeq = seq;
    document.querySelectorAll('.seq-item').forEach(i => i.classList.remove('active'));
    if (itemEl) itemEl.classList.add('active');

    $('seqTitle').textContent = seq.name;
    $('seqBadges').innerHTML = `
      <span class="badge">#${seq.id}</span>
      <span class="badge">Group: ${escapeHtml(seq.groupName)}</span>
      <span class="badge">Priority ${seq.priority}</span>
      <span class="badge">${seq.eventCount} events</span>
    `;

    renderTimeline(seq);

    $('seqEvents').innerHTML = seq.events.map((e, idx) => {
      let tag = 'tag-misc';
      if (e.action === 'START') tag = 'tag-start';
      else if (e.action === 'STOP') tag = 'tag-stop';
      else if (e.type.includes('Relay')) tag = 'tag-relay';
      const playable = e.cmd === 144 && e.audioFile;
      return `<tr data-ridx="${idx}">
        <td>${playable ? `<button class="row-play" data-ridx="${idx}" title="Play ${escapeHtml(e.audioFile)}">▶</button>` : ''}</td>
        <td class="mono">${e.timecode}</td>
        <td class="mono">${e.timeSeconds}</td>
        <td class="mono">${e.frame}</td>
        <td>${escapeHtml(e.type)}</td>
        <td><span class="tag ${tag}">${e.action}</span></td>
        <td><b>${escapeHtml(e.target || '-')}</b></td>
        <td>${escapeHtml(e.detail)}</td>
      </tr>`;
    }).join('');

    $('seqEvents').querySelectorAll('.row-play').forEach(btn => {
      btn.addEventListener('click', () => playRow(parseInt(btn.dataset.ridx, 10)));
    });

    const hasAudio = seq.events.some(e => e.cmd === 144 && e.audioFile);
    $('btnSeqPlay').disabled = !hasAudio;
    $('btnSeqStop').disabled = true;
  }

  function renderTimeline(seq) {
    const el = $('seqTimeline');
    if (!seq.events.length) { el.innerHTML = '<span class="empty-note">No events</span>'; return; }

    const max = seq.events[seq.events.length - 1].frame || 1;
    el.innerHTML = '<div class="tl-axis"></div>';
    seq.events.forEach(e => {
      const b = document.createElement('div');
      b.className = 'tl-block' + (e.type.includes('Audio') ? ' audio' : e.type.includes('Relay') ? ' relay' : '');
      const left = (e.frame / max) * 100;
      b.style.left = `${left}%`;
      b.style.width = '3px';
      b.title = `${e.timecode} ${e.type} ${e.action} ${e.target}`;
      el.appendChild(b);
    });
  }

  /* ---------------- Audio ---------------- */
  function renderAudio() {
    $('waveRows').innerHTML = state.waves.map(w => {
      const m = matchedFile(w.name);
      let icon, iconCls, iconTitle;
      if (w.name.startsWith('B_')) {
        icon = 'R'; iconCls = 'file-miss';
        iconTitle = 'Radio/Beacon reference — not in audio folder';
      } else if (m) {
        icon = m.type === 'exact' ? '✓' : '≈';
        iconCls = 'file-ok';
        iconTitle = `Matched ${m.type} → ${m.file}`;
      } else {
        icon = '✗'; iconCls = 'file-miss';
        iconTitle = 'No file found in linked audio folder';
      }
      return `<tr>
      <td><span class="${iconCls}" title="${escapeHtml(iconTitle)}">${icon}</span></td>
      <td class="mono">#${w.id}</td>
      <td><b class="accent">${escapeHtml(w.name)}</b></td>
      <td class="mono">${w.durationLabel}</td>
      <td>${w.stereo ? 'Stereo (2)' : 'Mono (1)'}</td>
      <td class="mono">${w.sampleRate} Hz</td>
      <td class="mono">${w.samples.toLocaleString()}</td>
      <td><button class="row-play" data-wave="${w.id}" title="Play ${escapeHtml(w.name)}" ${m ? '' : 'disabled'}>▶</button></td>
    </tr>`;
    }).join('');

    $('waveRows').querySelectorAll('.row-play').forEach(btn => {
      btn.addEventListener('click', () => {
        const w = state.waves.find(x => x.id === parseInt(btn.dataset.wave, 10));
        if (w) { stopSequencePlayback(); playFileNow(w.name); }
      });
    });
  }

  /* ---------------- Phrases ---------------- */
  function renderPhrases() {
    $('phraseRows').innerHTML = Object.values(state.phrases).map(p => `<tr>
      <td class="mono">#${p.id}</td>
      <td><b>${escapeHtml(p.waveName)}</b></td>
      <td class="mono">${p.track}</td>
      <td class="mono">${p.volL} / ${p.volR}</td>
      <td class="mono">${p.pitch}</td>
      <td class="mono">${p.fadeIn}ms / ${p.fadeOut}ms</td>
      <td><span class="tag tag-misc">${escapeHtml(p.speaker)}</span></td>
    </tr>`).join('');
  }

  /* ---------------- Routing ---------------- */
  function renderRouting() {
    const rows = [];
    Object.values(state.routing).forEach(g => {
      Object.entries(g.mappings).forEach(([ch, phrId]) => {
        const phrase = state.phrases[phrId] || {};
        rows.push(`<tr>
          <td><b class="accent">${escapeHtml(g.name)}</b></td>
          <td class="mono">Channel ${ch}</td>
          <td class="mono">Phrase #${phrId}</td>
          <td>${escapeHtml(phrase.waveName || 'None')}</td>
        </tr>`);
      });
    });
    $('routingRows').innerHTML = rows.join('') || '<tr><td colspan="4" class="empty-note">No routing data</td></tr>';
  }

  /* ---------------- Hardware ---------------- */
  function renderHardware() {
    $('triggerRows').innerHTML = state.triggers.map(t => `<tr>
      <td class="mono">Pin ${t.id}</td>
      <td><b>${escapeHtml(t.name)}</b></td>
      <td><span class="tag tag-relay">${escapeHtml(t.kind)}</span></td>
      <td>${t.targetSequenceName ? `Seq #${t.targetSequenceId} (${escapeHtml(t.targetSequenceName)})` : '-'}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="empty-note">No triggers</td></tr>';

    $('eqRows').innerHTML = state.equalizer.map(e => `<tr>
      <td class="mono">P${e.profile} B${e.bank}</td>
      <td class="mono">0x${e.register.toString(16).toUpperCase()} (${e.register})</td>
      <td class="mono">${e.value}</td>
      <td class="mono">${e.signed > 0 ? '+' : ''}${e.signed}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="empty-note">No EQ data</td></tr>';
  }

  /* ---------------- EQ Curves ---------------- */
  function renderEQ() {
    const zones = state.eqZones || [];

    if (!zones.length) {
      $('zoneTabs').innerHTML = '<span class="empty-note">No EQ data (Section Q) in this file.</span>';
      $('eqLegend').innerHTML = '';
      $('eqBands').innerHTML = '';
      $('eqRegisterGrid').innerHTML = '';
      $('eqZoneName').textContent = '-';
      const c = $('eqCanvas');
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, c.width, c.height);
      return;
    }

    $('zoneTabs').querySelectorAll('.zone-tab').forEach(btn => {
      const z = parseInt(btn.dataset.zone, 10);
      btn.classList.toggle('active', z === activeZone);
      btn.onclick = () => { activeZone = z; renderEQ(); };
    });

    const active = activeZone === -1 ? zones[0] : zones[activeZone];
    $('eqZoneName').textContent = active.name + (activeZone === -1 ? ' (showing all zones)' : '');

    drawEQ(zones, activeZone);

    $('eqLegend').innerHTML = zones.map((z, i) =>
      `<span class="item"><span class="swatch" style="background:${ZONE_COLORS[i % ZONE_COLORS.length]}"></span>${escapeHtml(z.name)}</span>`
    ).join('');

    $('eqBands').innerHTML = active.bands.map((b, i) => {
      const cut = b.type === 'lowpass' || b.type === 'highpass';
      return `<div class="band-row">
        <div class="band-name"><b>B${i + 1}</b> ${escapeHtml(b.name)}</div>
        <div class="band-params">
          <span class="bp">${fmtFreq(b.freq)}</span>
          ${cut ? '<span class="bp">cutoff</span>' : `<span class="bp">${b.gain > 0 ? '+' : ''}${b.gain} dB</span>`}
          <span class="bp">Q ${b.q}</span>
        </div>
      </div>`;
    }).join('');

    const regs = Object.entries(state.eqRegisterMap || {}).sort((a, b) => a[0] - b[0]);
    $('eqRegisterGrid').innerHTML = regs.map(([reg, val]) => {
      const db = (val - 64) * (15 / 64);
      return `<div class="reg-cell"><span class="reg-id">#${reg}</span><span class="reg-val">${val}</span><span class="reg-db">${db > 0 ? '+' : ''}${db.toFixed(1)}</span></div>`;
    }).join('') || '<span class="empty-note">No registers</span>';
  }

  function drawEQ(zones, zoneIndex) {
    const canvas = $('eqCanvas');
    const wrap = canvas.parentElement;
    const w = Math.max(320, wrap.clientWidth);
    const h = 320;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const padL = 44, padR = 14, padT = 14, padB = 24;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const FMIN = 20, FMAX = 20000, DBMIN = -24, DBMAX = 24;
    const fx = (f) => padL + (Math.log10(f / FMIN) / Math.log10(FMAX / FMIN)) * plotW;
    const dy = (db) => padT + (1 - (db - DBMIN) / (DBMAX - DBMIN)) * plotH;

    ctx.font = '10px ui-monospace, Consolas, monospace';
    ctx.textBaseline = 'middle';

    [20, 30, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].forEach(f => {
      const x = fx(f);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
      ctx.fillStyle = 'rgba(160,175,200,0.55)';
      ctx.textAlign = 'center';
      ctx.fillText(f >= 1000 ? (f / 1000) + 'k' : String(f), x, h - padB + 11);
    });

    for (let db = -18; db <= 18; db += 6) {
      const y = dy(db);
      ctx.strokeStyle = db === 0 ? 'rgba(34,211,238,0.35)' : 'rgba(255,255,255,0.06)';
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
      ctx.fillStyle = db === 0 ? 'rgba(34,211,238,0.85)' : 'rgba(160,175,200,0.55)';
      ctx.textAlign = 'right';
      ctx.fillText((db > 0 ? '+' : '') + db, padL - 6, y);
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.strokeRect(padL, padT, plotW, plotH);

    const stepCount = 240;
    const drawZone = (zone, idx, alpha, glow) => {
      const color = ZONE_COLORS[idx % ZONE_COLORS.length];
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      for (let i = 0; i <= stepCount; i++) {
        const f = FMIN * Math.pow(FMAX / FMIN, i / stepCount);
        const db = clamp(window.LCUDsp.chainDb(zone.bands, f, ZONE_FS), DBMIN, DBMAX);
        const x = fx(f), y = dy(db);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = glow ? 2.5 : 1.5;
      ctx.shadowColor = color;
      ctx.shadowBlur = glow ? 10 : 0;
      ctx.stroke();
      ctx.restore();
    };

    if (zoneIndex === -1) {
      zones.forEach((z, i) => drawZone(z, i, 0.95, true));
    } else {
      zones.forEach((z, i) => { if (i !== zoneIndex) drawZone(z, i, 0.22, false); });
      drawZone(zones[zoneIndex], zoneIndex, 1, true);
    }
  }

  function fmtFreq(f) {
    return f >= 1000 ? (f / 1000).toFixed(f % 1000 === 0 ? 0 : 1) + ' kHz' : Math.round(f) + ' Hz';
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /* ---------------- Raw ---------------- */
  function renderRaw() {
    $('rawList').innerHTML = Object.entries(state.rawSections).map(([key, lines]) => `
      <div class="raw-section">
        <header>"${key}" — ${lines.length} lines</header>
        <pre>${lines.map(escapeHtml).join('\n')}</pre>
      </div>
    `).join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ---------------- Export ---------------- */
  function setupExports() {
    $('btnExportJSON').addEventListener('click', async () => {
      if (!state || !window.lcuAPI) return;
      await window.lcuAPI.saveFile({
        defaultName: state.filename.replace(/\.lcu$/i, '') + '_decoded.json',
        content: JSON.stringify(state, null, 2),
        filterName: 'JSON Document (*.json)',
        extension: 'json'
      });
    });

    $('btnExportAUP').addEventListener('click', async () => {
      if (!state || !window.lcuAPI) return;
      await window.lcuAPI.saveAup({
        defaultName: state.filename.replace(/\.lcu$/i, '') + '_audacity.aup',
        content: dec.buildAudacityProject(state)
      });
    });

    $('btnExportCSV').addEventListener('click', async () => {
      if (!state || !window.lcuAPI) return;
      let csv = 'Sequence_ID,Sequence_Name,Group,Timecode_SMPTE,Time_Seconds,Frame,Type,Action,Target,Details\n';
      state.sequences.forEach(s => {
        s.events.forEach(e => {
          const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
          csv += `${s.id},${esc(s.name)},${esc(s.groupName)},${e.timecode},${e.timeSeconds},${e.frame},${esc(e.type)},${e.action},${esc(e.target)},${esc(e.detail)}\n`;
        });
      });
      await window.lcuAPI.saveFile({
        defaultName: state.filename.replace(/\.lcu$/i, '') + '_timeline.csv',
        content: csv,
        filterName: 'CSV Document (*.csv)',
        extension: 'csv'
      });
    });
  }

  /* ---------------- Audio folder + playback ---------------- */
  let seqPlayback = { timers: [], active: [], hl: new Set(), stopped: true, chans: {} };

  function setupAudioLinks() {
    $('btnLinkAudio').addEventListener('click', async () => {
      if (!window.lcuAPI) return;
      const res = await window.lcuAPI.linkAudioFolder();
      if (res && res.success) {
        setAudioInfo(res.path, res.files);
        updateLinkStatus();
        if (state) { renderAudio(); renderSequences(); }
      }
    });

    if (window.lcuAPI) {
      window.lcuAPI.getAudioState().then(res => {
        if (res && res.linked) {
          setAudioInfo(res.path, res.files);
          updateLinkStatus();
          if (state) { renderAudio(); renderSequences(); }
        }
      });
    }
  }

  function setupPlaybackSettings() {
    const getPref = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
    const setPref = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
    audioEngine.eq = getPref('lcu.playEq', true);
    audioEngine.levels = getPref('lcu.playLevels', true);
    audioEngine.zoneForBus = { 0: getPref('lcu.bus0Zone', 0), 1: getPref('lcu.bus1Zone', 2) };
    $('chkPlayEq').checked = audioEngine.eq;
    $('chkPlayLevels').checked = audioEngine.levels;
    $('selBus0Zone').value = audioEngine.zoneForBus[0];
    $('selBus1Zone').value = audioEngine.zoneForBus[1];

    $('chkPlayEq').addEventListener('change', () => {
      audioEngine.eq = $('chkPlayEq').checked;
      setPref('lcu.playEq', audioEngine.eq);
      seqPlayback.active.forEach(rerouteCue);
    });
    $('chkPlayLevels').addEventListener('change', () => {
      audioEngine.levels = $('chkPlayLevels').checked;
      setPref('lcu.playLevels', audioEngine.levels);
      seqPlayback.active.forEach(c => {
        c.gain.gain.setTargetAtTime(cueGain(c.phrase, c.ch), ensureCtx().currentTime, 0.03);
      });
    });
    $('selBus0Zone').addEventListener('change', () => {
      audioEngine.zoneForBus[0] = parseInt($('selBus0Zone').value, 10);
      setPref('lcu.bus0Zone', audioEngine.zoneForBus[0]);
      seqPlayback.active.forEach(rerouteCue);
    });
    $('selBus1Zone').addEventListener('change', () => {
      audioEngine.zoneForBus[1] = parseInt($('selBus1Zone').value, 10);
      setPref('lcu.bus1Zone', audioEngine.zoneForBus[1]);
      seqPlayback.active.forEach(rerouteCue);
    });
  }

  function setAudioInfo(dirPath, files) {
    audioInfo.path = dirPath;
    audioInfo.linked = true;
    audioInfo.files = files || [];
    rebuildLinks();
  }

  /* ---------------- Fuzzy name linking ---------------- */
  function normForMatch(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/^(.*)[/\\]/, '')           // strip any dir prefix
      .replace(/\.[a-z0-9]{1,5}$/, '')     // strip extension
      .replace(/[^a-z0-9]+/g, '');         // keep letters/digits only
  }

  function bigrams(s) {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  }

  function dice(a, b) {
    if (a === b) return 1;
    const A = bigrams(a), B = bigrams(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    A.forEach(n => { if (B.has(n)) inter++; });
    return (2 * inter) / (A.size + B.size);
  }

  // Assign each wave to its best-matching file on disk (1:1). Match tiers:
  // exact > contains > fuzzy (bigram Dice similarity with lenght guard).
  function rebuildLinks() {
    audioInfo.links = {};
    if (!state) return;

    const files = audioInfo.files || [];
    const fileEntries = files.map(f => ({ file: f, n: normForMatch(f) })).filter(e => e.n);

    const candidates = {};
    state.waves.forEach(w => {
      const nn = normForMatch(w.name);
      const cs = [];
      if (nn) {
        fileEntries.forEach(fe => {
          let type = null, score = 0;
          if (fe.n === nn) { type = 'exact'; score = 1; }
          else if (nn.length >= 3 && (fe.n.includes(nn) || nn.includes(fe.n))) { type = 'contains'; score = 0.9; }
          else {
            const d = dice(fe.n, nn);
            const lenRatio = Math.min(fe.n.length, nn.length) / Math.max(fe.n.length, nn.length);
            if (d >= 0.55 && lenRatio >= 0.6) { type = 'fuzzy'; score = d * 0.8 + lenRatio * 0.2; }
          }
          if (type) cs.push({ file: fe.file, type, score });
        });
      }
      cs.sort((a, b) => b.score - a.score);
      candidates[w.name] = cs;
    });

    const taken = new Set();
    state.waves
      .slice()
      .sort((a, b) => (candidates[b.name] && candidates[b.name][0] ? candidates[b.name][0].score : -1) -
                      (candidates[a.name] && candidates[a.name][0] ? candidates[a.name][0].score : -1))
      .forEach(w => {
        const cs = candidates[w.name] || [];
        for (let i = 0; i < cs.length; i++) {
          if (taken.has(cs[i].file)) continue;
          audioInfo.links[w.name] = cs[i];
          taken.add(cs[i].file);
          break;
        }
      });
  }

  function matchedFile(name) {
    if (!name || !audioInfo.linked) return null;
    const m = audioInfo.links[name];
    return m || null;
  }

  function updateLinkStatus() {
    const el = $('audioLinkStatus');
    if (!audioInfo.linked) { el.textContent = 'No audio folder linked'; el.title = ''; return; }
    const total = state ? state.waves.length : 0;
    const found = state ? state.waves.filter(w => matchedFile(w.name)).length : 0;
    el.textContent = `${audioInfo.path} · ${total ? `${found}/${total} files found` : `${audioInfo.files.length} files`}`;
    el.title = audioInfo.path;
  }

  function audioReady(name) {
    return !!matchedFile(name);
  }

  function audioUrl(file) {
    return 'lcu-audio://local/' + encodeURIComponent(file);
  }

  function srcFor(name) {
    const m = matchedFile(name);
    return m ? audioUrl(m.file) : null;
  }

  function seqEndedMaybeIdle() {
    if (!seqPlayback.timers.length && !seqPlayback.active.length) $('btnSeqStop').disabled = true;
  }

  function markRow(idx, on) {
    if (idx == null) return;
    const tr = document.querySelector(`#seqEvents tr[data-ridx="${idx}"]`);
    if (on) {
      seqPlayback.hl.add(idx);
      if (tr) tr.classList.add('playing');
    } else {
      seqPlayback.hl.delete(idx);
      if (tr) tr.classList.remove('playing');
    }
  }

  function clearRowHighlights() {
    seqPlayback.hl.forEach(i => markRow(i, false));
  }

  // ---- WebAudio processing pipeline ----
  function ensureCtx() {
    if (!audioEngine.ctx) audioEngine.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioEngine.ctx.state === 'suspended') audioEngine.ctx.resume();
    return audioEngine.ctx;
  }

  function zoneBandSpecs(zoneIdx) {
    if (audioEngine.zoneSpecs[zoneIdx]) return audioEngine.zoneSpecs[zoneIdx];
    const zone = (state && state.eqZones) ? state.eqZones[zoneIdx] : null;
    const specs = [];
    if (zone) zone.bands.forEach(b => {
      if (!b.enabled) return;
      specs.push({ type: b.type, freq: b.freq, q: b.q || 0.707, gain: b.gain });
    });
    audioEngine.zoneSpecs[zoneIdx] = specs;
    return specs;
  }

  // Every cue owns its own filter nodes (built from the shared band specs) so
  // stopping or cutting one cue can never tear down another cue's EQ chain.
  function buildFilters(zoneIdx) {
    const specs = audioEngine.eq ? zoneBandSpecs(zoneIdx) : [];
    const ctx = ensureCtx();
    const made = [];
    specs.forEach(s => {
      const f = ctx.createBiquadFilter();
      f.type = s.type;
      f.frequency.value = s.freq;
      f.Q.value = s.q;
      if (s.type !== 'highpass' && s.type !== 'lowpass') f.gain.value = s.gain;
      made.push(f);
    });
    return made;
  }

  function zoneIndexFor(phrase) {
    const bus = phrase ? (phrase.outputBus || 0) : 0;
    return audioEngine.zoneForBus[bus] !== undefined ? audioEngine.zoneForBus[bus] : (bus === 1 ? 2 : 0);
  }

  function makeChain(phrase) {
    const ctx = ensureCtx();
    const gain = ctx.createGain();
    const env = ctx.createGain();   // per-cue phrase fade in/out envelope
    const panner = ctx.createStereoPanner();
    const zoneIdx = zoneIndexFor(phrase);
    const filters = buildFilters(zoneIdx);
    const nodes = [gain, env].concat(filters, [panner]);
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    panner.connect(ctx.destination);
    return { gain, env, panner, zoneIdx, filters, nodes };
  }

  function disposeGraph(cue) {
    try { cue.src.disconnect(); } catch (e) {}
    if (cue.nodes) cue.nodes.forEach(n => { try { n.disconnect(); } catch (e) {} });
  }

  function rerouteCue(cue) {
    disposeGraph(cue);
    const ctx = ensureCtx();
    cue.filters = buildFilters(zoneIndexFor(cue.phrase));
    cue.nodes = [cue.gain, cue.env].concat(cue.filters, [cue.panner]);
    for (let i = 0; i < cue.nodes.length - 1; i++) cue.nodes[i].connect(cue.nodes[i + 1]);
    cue.panner.connect(ctx.destination);
    cue.src.connect(cue.gain);
  }

  function loadBuffer(name) {
    const s = srcFor(name);
    if (!s) return Promise.reject(new Error('No matched audio file for ' + name));
    if (audioEngine.buffers.has(name)) return audioEngine.buffers.get(name);
    const p = (async () => {
      const res = await fetch(s);
      if (!res.ok) throw new Error('Fetch failed: ' + res.status + ' ' + name);
      const ctx = ensureCtx();
      return ctx.decodeAudioData(await res.arrayBuffer());
    })();
    audioEngine.buffers.set(name, p);
    p.catch(() => audioEngine.buffers.delete(name));
    return p;
  }

  function flatRouting() {
    if (!audioEngine.flatRoute) {
      const f = {};
      Object.values(state.routing).forEach(g => Object.assign(f, g.mappings));
      audioEngine.flatRoute = f;
    }
    return audioEngine.flatRoute;
  }

  function phraseForChannel(ch, seq) {
    if (!state || !state.phrases) return null;
    const g = seq && state.routing[seq.groupId];
    const map = (g && g.mappings) || flatRouting();
    const phrId = map[ch] !== undefined ? map[ch] : ch;
    return state.phrases[phrId] || null;
  }

  function chanState(ch) {
    let s = seqPlayback.chans[ch];
    if (!s) { s = { vol: 127, fade: 127, pan: 64 }; seqPlayback.chans[ch] = s; }
    return s;
  }

  function cueGain(phrase, ch) {
    if (!audioEngine.levels) return 1;
    let g = 1;
    if (phrase) g *= Math.max(0, Math.min(127, (phrase.volL + phrase.volR) / 2)) / 127;
    if (ch != null) {
      const st = seqPlayback.chans[ch];
      if (st) g *= (Math.max(0, st.vol) / 127) * (Math.max(0, st.fade) / 127);
    }
    return Math.max(0.0001, Math.min(2, g));
  }

  function refreshChannel(ch) {
    const ctx = ensureCtx();
    const t = ctx.currentTime;
    seqPlayback.active.filter(c => c.ch === ch).forEach(c => {
      c.gain.gain.setTargetAtTime(cueGain(c.phrase, ch), t, 0.05);
      c.panner.pan.setTargetAtTime((chanState(ch).pan - 64) / 64, t, 0.05);
    });
  }

  function stopCue(cue, unmark) {
    if (cue.finished) return;
    cue.finished = true;
    try { cue.src.onended = null; } catch (e) {}
    // Short release ramp so cuts don't click; looped beds get a slightly
    // longer release so a show STOP fades them out instead of chopping them.
    const release = cue.looped ? 0.08 : 0.015;
    let stopped = false;
    const doStop = () => { if (stopped) return; stopped = true; try { cue.src.stop(); } catch (e) {} disposeGraph(cue); };
    try {
      const ctx = ensureCtx();
      const t = ctx.currentTime;
      cue.env.gain.cancelScheduledValues(t);
      cue.env.gain.setValueAtTime(cue.env.gain.value, t);
      cue.env.gain.linearRampToValueAtTime(0, t + release);
      setTimeout(doStop, Math.ceil(release * 1000) + 30);
    } catch (e) {
      doStop();
    }
    if (unmark) markRow(cue.idx, false);
  }

  // A new START or a STOP command for a channel silences that channel's current cue.
  function cutChannel(ch, except) {
    seqPlayback.active
      .filter(c => c.ch === ch && c !== except)
      .forEach(c => stopCue(c, true));
    seqPlayback.active = seqPlayback.active.filter(c => c.ch !== ch || c === except);
  }

  // Each cue is loaded into an AudioBuffer and played through its own
  // gain -> fade envelope -> 3-zone EQ chain -> stereo pan graph.
  function spawnCue(e, idx, seq) {
    const phrase = phraseForChannel(e.p1, seq);
    return loadBuffer(e.audioFile).then(buf => {
      if (seqPlayback.stopped) return;
      cutChannel(e.p1, null);
      const ctx = ensureCtx();
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const wave = waveForPhrase(phrase, e.audioFile);
      const looped = !!(wave && wave.flag === 1);
      src.loop = looped;
      const graph = makeChain(phrase);
      src.connect(graph.gain);
      const cue = { src, phrase, ch: e.p1, idx, looped, gain: graph.gain, env: graph.env, panner: graph.panner, zoneIdx: graph.zoneIdx, filters: graph.filters, nodes: graph.nodes, finished: false };
      cue.gain.gain.value = cueGain(phrase, e.p1);
      cue.panner.pan.value = (chanState(e.p1).pan - 64) / 64;
      applyFadeEnvelope(cue, buf.duration, looped);
      seqPlayback.active.push(cue);
      markRow(idx, true);
      src.onended = () => {
        if (cue.finished) return;
        cue.finished = true;
        seqPlayback.active = seqPlayback.active.filter(c => c !== cue);
        markRow(idx, false);
        disposeGraph(cue);
        seqEndedMaybeIdle();
      };
      src.start(cue.startAt);
    }).catch(err => console.warn('Playback error:', err));
  }

  // The LCU wave table flags looped samples (flag === 1): ambience/idle beds
  // that must keep repeating until the show sends a STOP for their channel.
  function waveForPhrase(phrase, name) {
    if (!state || !state.waves) return null;
    if (phrase && phrase.waveId != null) {
      const w = state.waves.find(x => x.id === phrase.waveId);
      if (w) return w;
    }
    return state.waves.find(x => x.name === name) || null;
  }

  // Phrase presets carry a fade-in and fade-out time (ms; fade-out stored
  // negative). Schedule them on the cue's envelope gain so the sound ramps up
  // from silence and ramps down into its natural end. Looped samples have no
  // natural end, so only their fade-in applies.
  function applyFadeEnvelope(cue, bufferDuration, looped) {
    const ctx = ensureCtx();
    const phrase = cue.phrase || {};
    const startAt = ctx.currentTime + 0.01;
    cue.startAt = startAt;
    const fadeIn = Math.max(0, phrase.fadeIn || 0) / 1000;
    const fadeOut = Math.max(0, Math.abs(phrase.fadeOut || 0)) / 1000;
    const g = cue.env.gain;
    g.cancelScheduledValues(startAt);
    const inEnd = Math.min(startAt + fadeIn, startAt + bufferDuration);
    if (fadeIn > 0) {
      g.setValueAtTime(0, startAt);
      g.linearRampToValueAtTime(1, inEnd);
    } else {
      g.setValueAtTime(1, startAt);
    }
    const endAt = startAt + bufferDuration;
    if (!looped && fadeOut > 0 && endAt - fadeOut > inEnd) {
      g.setValueAtTime(1, endAt - fadeOut);
      g.linearRampToValueAtTime(0, endAt);
    }
  }

  function stopSequencePlayback() {
    seqPlayback.stopped = true;
    seqPlayback.timers.forEach(t => clearTimeout(t));
    seqPlayback.timers = [];
    seqPlayback.active.forEach(c => stopCue(c, true));
    seqPlayback.active = [];
    clearRowHighlights();
    $('btnSeqStop').disabled = true;
  }

  function playFileNow(name) {
    if (!audioReady(name)) {
      alert('No linked audio folder file matches:\n' + name);
      return false;
    }
    seqPlayback.stopped = false;
    ensureCtx().resume();
    spawnCue({ p1: null, audioFile: name }, null, null);
    $('btnSeqStop').disabled = false;
    return true;
  }

  function playRow(idx) {
    if (!currentSeq) return;
    const e = currentSeq.events[idx];
    if (!e || e.cmd !== 144 || !e.audioFile) return;
    stopSequencePlayback();
    seqPlayback.stopped = false;
    ensureCtx().resume();
    spawnCue(e, idx, currentSeq);
    $('btnSeqStop').disabled = false;
  }

  function playSequence(seq) {
    // Audible events: channel START/STOP (play/silence) plus per-channel
    // level events (vol / pan / fade) that shape the running mix.
    const cues = seq.events
      .map((e, i) => ({ e, i }))
      .filter(x => ((x.e.cmd === 144 || x.e.cmd === 128) && x.e.audioFile) ||
                   x.e.cmd === 7 || x.e.cmd === 8 || x.e.cmd === 11);
    const starts = cues.filter(x => x.e.cmd === 144);
    if (!starts.length) { alert('This sequence has no playable audio events.'); return; }
    stopSequencePlayback();

    const missing = starts.filter(x => !srcFor(x.e.audioFile));
    if (missing.length && !confirm('Missing in the audio folder:\n' +
        missing.map(x => x.e.audioFile).join('\n') + '\n\nPlay available audio anyway?')) {
      return;
    }

    seqPlayback.stopped = false;
    seqPlayback.chans = {};
    ensureCtx().resume();

    const t0 = starts[0].e.timeSeconds;
    const files = [...new Set(starts.map(x => x.e.audioFile))];
    files.forEach(f => loadBuffer(f).catch(err => console.warn('Audio load failed: ' + f, err)));

    const runCue = (x) => {
      const e = x.e;
      // Negative parameter values mark "no change" in the show data.
      if (e.cmd === 7 && e.p2 >= 0) { chanState(e.p1).vol = e.p2; refreshChannel(e.p1); }
      else if (e.cmd === 8 && e.p2 >= 0) { chanState(e.p1).pan = e.p2; refreshChannel(e.p1); }
      else if (e.cmd === 11 && e.p2 >= 0) { chanState(e.p1).fade = e.p2; refreshChannel(e.p1); }
      else if (e.cmd === 128) { cutChannel(e.p1, null); }
      else if (e.cmd === 144) { spawnCue(e, x.i, seq); }
    };
    const laterCue = (x, delay) => {
      let id;
      id = setTimeout(() => {
        seqPlayback.timers = seqPlayback.timers.filter(t => t !== id);
        runCue(x);
        seqEndedMaybeIdle();
      }, delay);
      seqPlayback.timers.push(id);
    };

    let syncDone = false;
    cues.forEach(x => {
      const delay = Math.round((x.e.timeSeconds - t0) * 1000);
      if (delay <= 0 && !syncDone && x.e.cmd === 144) {
        runCue(x);   // first cue runs inside the click for the autoplay gesture
        syncDone = true;
      } else if (delay <= 0) {
        laterCue(x, 0);
      } else {
        laterCue(x, delay);
      }
    });

    $('btnSeqStop').disabled = false;
  }

  /* ---------------- Drag & drop ---------------- */
  function setupDrop() {
    const overlay = document.createElement('div');
    overlay.className = 'drop-overlay';
    overlay.textContent = 'Drop .lcu file to open';
    document.body.appendChild(overlay);

    let depth = 0;
    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      depth++;
      overlay.classList.add('show');
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('dragleave', (e) => {
      e.preventDefault();
      depth--;
      if (depth <= 0) { depth = 0; overlay.classList.remove('show'); }
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      overlay.classList.remove('show');
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (re) => load(re.target.result, file.name, null);
      reader.readAsText(file, 'latin1');
    });
  }
})();