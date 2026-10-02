/**
 * LCU Reader Decoder
 *
 * Decodes Rock 'n' Roller Coaster Soundtracker Local Control Unit (.lcu) files.
 * The format is a line-based text file split into sections named by quoted
 * markers ("V", "K", "C", "D", "E", "O", "G", "P", "R", "S", "T", "W", "M",
 * "Q", "F", "A"). Each section holds numeric/string records terminated by
 * "-2000" (or "-1" for inner lists).
 *
 * Fully decoded sections: V, K, O, D, G, W, P, R, T, S, Q
 * Raw-only sections:     C, E, M, F, A (kept as text for reference)
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LCUReader = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  const RELAY_NAMES = {
    3: 'Test switch',
    4: 'Sensor 1 (Track Sensor)',
    5: 'Sensor 2 (Track Sensor)',
    6: 'I.R. Sensor (Launch Sensor)',
    7: 'Test Light',
    8: 'Lights Rear (Taillights)',
    9: 'Fan (Cooling Fan)',
    10: 'Lights Front (Headlights)',
    31: 'Unmute'
  };

  const OPCODES = {
    144: { name: 'Audio Playback', action: 'START' },
    128: { name: 'Audio Playback', action: 'STOP' },
    7:   { name: 'Volume Control', action: 'SET_VOLUME' },
    8:   { name: 'Pan / Balance',  action: 'SET_PAN' },
    9:   { name: 'Relay / Lighting', action: 'RELAY' },
    11:  { name: 'Fade / Expression', action: 'SET_FADE' },
    12:  { name: 'Sequence Trigger', action: 'CALL_SEQUENCE' },
    15:  { name: 'Relay / Output Control', action: 'OUTPUT' },
    176: { name: 'DSP / Equalizer', action: 'SET_DSP' }
  };

  function xmlAttr(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Build an Audacity 2.x project (.aup) from a decoded LCU.
   *
   * All sequences are laid out on a single timeline: the audio and relay
   * events become labels (time-span labels for audio, point labels for
   * relays), and one empty audio track is created per output bus. The audio
   * itself is not stored in an LCU, so the tracks open silent; use them as
   * placeholders to drop the real wave files onto.
   */
  function buildAudacityProject(decoded) {
    const waves = decoded.waves || [];
    const rate = (waves[0] && waves[0].sampleRate) || 44100;

    const buses = {};
    Object.keys(decoded.phrases || {}).forEach(function (k) {
      const p = decoded.phrases[k];
      buses[p.outputBus] = p.speaker;
    });
    let busList = Object.keys(buses).map(function (k) {
      return { bus: Number(k), name: buses[k] };
    });
    if (!busList.length) busList = [{ bus: 0, name: 'Audio' }];

    const labels = [];
    (decoded.sequences || []).forEach(function (seq) {
      (seq.events || []).forEach(function (e) {
        const title = '[' + seq.name + '] ' + (e.detail || e.type);
        if (e.audioFile) {
          const dur = e.audioDur > 0 ? e.audioDur : 0;
          labels.push({ t: e.timeSeconds, t1: e.timeSeconds + dur, title: title });
        } else if (e.relay) {
          labels.push({ t: e.timeSeconds, t1: e.timeSeconds, title: title });
        }
      });
    });

    const lines = [];
    lines.push('<?xml version="1.0" standalone="no" ?>');
    lines.push('<!DOCTYPE project>');
    lines.push('<project xmlns="http://audacity.sourceforge.net/xml/" version="1.3.0" audacityversion="3.0.0" rate="' + rate + '">');
    lines.push('  <tags/>');

    busList.forEach(function (b) {
      lines.push('  <wavetrack name="' + xmlAttr(b.name) + '" channel="0" linked="0" mute="0" solo="0" height="128" minimized="0" isSelected="0" rate="' + rate + '" gain="1.0" pan="0.0">');
      lines.push('    <waveclip offset="0.00000000">');
      lines.push('      <sequence maxsamples="262144" sampleformat="262159" numsamples="0">');
      lines.push('        <waveblock start="0"/>');
      lines.push('      </sequence>');
      lines.push('      <envelope numpoints="0"/>');
      lines.push('    </waveclip>');
      lines.push('  </wavetrack>');
    });

    lines.push('  <labeltrack name="Cues (all sequences)" numlabels="' + labels.length + '" height="120" minimized="0" isSelected="1">');
    labels.forEach(function (l) {
      lines.push('    <label t="' + l.t.toFixed(8) + '" t1="' + l.t1.toFixed(8) + '" title="' + xmlAttr(l.title) + '"/>');
    });
    lines.push('  </labeltrack>');
    lines.push('</project>');

    return lines.join('\n') + '\n';
  }

  function smpte(totalFrames, fps) {
    const r = fps || 30;
    const sec = Math.floor(totalFrames / r);
    const fr = totalFrames % r;
    const mm = Math.floor(sec / 60);
    const ss = sec % 60;
    const hh = Math.floor(mm / 60);
    return pad(hh, 2) + ':' + pad(mm % 60, 2) + ':' + pad(ss, 2) + ':' + pad(fr, 2);
  }

  function timeShort(totalFrames, fps) {
    const r = fps || 30;
    const sec = Math.floor(totalFrames / r);
    const fr = totalFrames % r;
    const mm = Math.floor(sec / 60);
    return pad(mm, 2) + ':' + pad(sec % 60, 2) + ':' + pad(fr, 2);
  }

  function pad(n, w) {
    return String(n).padStart(w, '0');
  }

  function decodeEvent(raw, ctx) {
    const cmd = raw.cmd;
    const info = OPCODES[cmd] || { name: 'Command', action: 'CMD_' + cmd };
    let target = '';
    let detail = '';
    let audioFile = '';
    let audioDur = 0;
    let speaker = '';
    let relay = '';
    let relayState = '';

    // Routing: map playback channel -> phrase preset, then phrase -> wave file
    const lookupPhrase = (ch) => {
      const mapped = ctx.route[ch];
      const phr = ctx.phrases[mapped !== undefined ? mapped : ch];
      return phr || null;
    };

    if (cmd === 144 || cmd === 128) {
      const phr = lookupPhrase(raw.p1);
      if (phr) {
        audioFile = phr.waveName;
        audioDur = phr.duration;
        speaker = phr.outputBus === 1 ? 'Subwoofers & Rear' : 'Front Speakers';
        target = audioFile;
        if (cmd === 144) {
          detail = 'Play \'' + audioFile + '\' on channel ' + raw.p1 + ' (' + speaker + ')';
        } else {
          detail = 'Stop \'' + audioFile + '\' on channel ' + raw.p1;
        }
      } else {
        target = 'Channel ' + raw.p1;
        detail = (cmd === 144 ? 'Play' : 'Stop') + ' audio on channel ' + raw.p1;
      }
    } else if (cmd === 7) {
      target = 'Channel ' + raw.p1;
      detail = 'Set channel ' + raw.p1 + ' volume to ' + raw.p2;
    } else if (cmd === 8) {
      target = 'Channel ' + raw.p1;
      detail = 'Set channel ' + raw.p1 + ' pan/balance to ' + raw.p2;
    } else if (cmd === 9 || cmd === 15) {
      const rName = RELAY_NAMES[raw.p1] || ('Relay ' + raw.p1);
      relay = rName;
      relayState = raw.p2 === 0 ? 'ON' : (raw.p2 === -1 ? 'OFF' : ('State ' + raw.p2));
      target = rName;
      detail = (cmd === 9 ? 'Relay' : 'Output') + ' ' + rName + ' -> ' + relayState;
    } else if (cmd === 11) {
      target = 'Channel ' + raw.p1;
      detail = 'Apply fade/expression to channel ' + raw.p1 + ' (val ' + raw.p2 + ')';
    } else if (cmd === 12) {
      const called = ctx.seqNames[raw.p1] || ('Sequence ' + raw.p1);
      target = 'Seq ' + raw.p1 + ': ' + called;
      detail = 'Trigger sub-sequence ' + raw.p1 + ' (' + called + ')';
    } else if (cmd === 176) {
      target = 'DSP Param ' + raw.p1;
      detail = 'DSP controller register ' + raw.p1 + ' = ' + raw.p2;
    } else {
      target = 'Param ' + raw.p1;
      detail = 'Opcode ' + cmd + ' (p1: ' + raw.p1 + ', p2: ' + raw.p2 + ')';
    }

    return {
      index: raw.index,
      frame: raw.frame,
      timeSeconds: +(raw.frame / 30).toFixed(2),
      timecode: smpte(raw.frame),
      timecodeShort: timeShort(raw.frame),
      cmd: cmd,
      p1: raw.p1,
      p2: raw.p2,
      type: info.name,
      action: info.action,
      target: target,
      detail: detail,
      audioFile: audioFile,
      audioDur: audioDur,
      speaker: speaker,
      relay: relay,
      relayState: relayState
    };
  }

  function splitSections(lines) {
    const sections = {};
    let current = null;
    let buffer = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const t = line.trim();
      if (t.charAt(0) === '"' && t.charAt(t.length - 1) === '"' && t.length <= 6) {
        if (current !== null) sections[current] = buffer;
        current = t.slice(1, -1);
        buffer = [];
      } else if (current !== null) {
        buffer.push(line);
      }
    }
    if (current !== null) sections[current] = buffer;
    return sections;
  }

  function isTerminator(line, value) {
    return line.trim() === value;
  }

  function decode(content, filename) {
    const lines = String(content).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const sections = splitSections(lines);

    const out = {
      filename: filename || 'unknown.lcu',
      version: null,
      metadata: { date: '', trainId: null, title: '', vehicleName: '', vehicleVersion: '' },
      network: { ip: '', gateway: '', subnet: '' },
      delays: [],
      groups: {},
      waves: [],
      phrases: {},
      routing: {},
      sequences: [],
      triggers: [],
      equalizer: [],
      eqRegisterMap: {},
      eqZones: [],
      rawSections: {}
    };

    // V - firmware version
    if (sections.V && sections.V.length) {
      out.version = parseInt(sections.V[0], 10) || null;
    }

    // K - metadata (date, train id, title)
    if (sections.K) {
      out.metadata.date = (sections.K[0] || '').trim();
      out.metadata.trainId = parseInt(sections.K[1], 10) || null;
      out.metadata.title = (sections.K[2] || '').trim();
    }

    // O - network config
    if (sections.O) {
      out.network.ip = (sections.O[0] || '').trim();
      out.network.gateway = (sections.O[1] || '').trim();
      out.network.subnet = (sections.O[2] || '').trim();
    }

    // D - delay presets
    if (sections.D && sections.D.length) {
      out.delays = sections.D[0].trim().split(/\s+/).map(Number).filter(n => !isNaN(n));
    }

    // G - audio group names (id, name) pairs
    if (sections.G) {
      const g = sections.G;
      for (let i = 0; i < g.length; i++) {
        if (isTerminator(g[i], '-2000')) break;
        const id = parseInt(g[i], 10);
        const name = (g[i + 1] || '').trim();
        if (!isNaN(id) && name) out.groups[id] = name;
        i += 1;
      }
    }

    // W - onboard sound library
    if (sections.W) {
      const w = sections.W;
      out.metadata.vehicleName = (w[0] || '').trim();
      out.metadata.vehicleVersion = (w[1] || '').trim();
      const n = parseInt(w[2], 10) || 0;
      for (let i = 3; i < w.length && out.waves.length < n; i += 6) {
        const id = parseInt(w[i], 10);
        if (isNaN(id)) break;
        const name = (w[i + 1] || '').trim();
        const sampleRate = parseInt(w[i + 2], 10) || 44100;
        const channels = parseInt(w[i + 3], 10) || 1;
        const flag = parseInt(w[i + 4], 10) || 0;
        const samples = parseInt(w[i + 5], 10) || 0;
        const dur = sampleRate > 0 ? samples / sampleRate : 0;
        out.waves.push({
          id: id,
          name: name,
          sampleRate: sampleRate,
          channels: channels,
          flag: flag,
          samples: samples,
          duration: +dur.toFixed(2),
          durationLabel: dur.toFixed(2) + 's',
          stereo: channels === 2
        });
      }
    }

    // P - phrase presets
    if (sections.P) {
      const p = sections.P;
      const n = parseInt(p[0], 10) || 0;
      const waveById = {};
      out.waves.forEach(w => { waveById[w.id] = w; });
      for (let i = 1; i < p.length && Object.keys(out.phrases).length < n; i += 9) {
        const pid = parseInt(p[i], 10);
        if (isNaN(pid)) break;
        const waveId = parseInt(p[i + 2], 10);
        const wave = waveById[waveId] || null;
        const bus = parseInt(p[i + 8], 10);
        out.phrases[pid] = {
          id: pid,
          track: parseInt(p[i + 1], 10),
          waveId: waveId,
          waveName: wave ? wave.name : ('Wave ' + waveId),
          duration: wave ? wave.duration : 0,
          volL: parseInt(p[i + 3], 10),
          volR: parseInt(p[i + 4], 10),
          pitch: parseInt(p[i + 5], 10),
          fadeIn: parseInt(p[i + 6], 10),
          fadeOut: parseInt(p[i + 7], 10),
          outputBus: bus,
          speaker: bus === 1 ? 'Subwoofers & Rear' : 'Front Speakers'
        };
      }
    }

    // R - channel to phrase routing matrix per group
    if (sections.R) {
      const r = sections.R;
      const n = r.length;
      let i = 0;
      while (i < n && !isTerminator(r[i], '-2000')) {
        const grpId = parseInt(r[i], 10);
        if (isNaN(grpId)) { i++; continue; }
        const grpName = (r[i + 1] || '').trim();
        i += 2;
        const mappings = {};
        while (i < n && !isTerminator(r[i], '-1') && !isTerminator(r[i], '-2000')) {
          const ch = parseInt(r[i], 10);
          const phr = parseInt(r[i + 1], 10);
          if (!isNaN(ch) && !isNaN(phr)) mappings[ch] = phr;
          i += 2;
        }
        if (isTerminator(r[i], '-1')) i++;
        out.routing[grpId] = { id: grpId, name: grpName, mappings: mappings };
      }
    }

    // T - hardware triggers / sensors
    if (sections.T) {
      const t = sections.T;
      const n = t.length;
      for (let i = 0; i + 9 < n; i += 10) {
        if (isTerminator(t[i], '-2000')) break;
        const id = parseInt(t[i], 10);
        if (isNaN(id)) break;
        const type = parseInt(t[i + 2], 10);
        const target = parseInt(t[i + 7], 10);
        out.triggers.push({
          id: id,
          name: (t[i + 1] || '').trim(),
          kind: type === 1 ? 'Input (Sensor)' : (type === 2 ? 'Output (Relay)' : 'Virtual'),
          type: type,
          targetSequenceId: target >= 0 ? target : null,
          targetSequenceName: ''
        });
      }
    }

    // S - show sequences + cue events
    if (sections.S) {
      const s = sections.S;
      const total = parseInt(s[0], 10) || 0;

      // Locate headers: a name line preceded by a number
      const headers = [];
      const namesById = {};
      for (let i = 1; i < s.length; i++) {
        const t = s[i].trim();
        const prev = s[i - 1].trim();
        if (/^[A-Za-z]/.test(t) && /^-?\d+$/.test(prev)) {
          const id = parseInt(prev, 10);
          headers.push({ id: id, name: t, index: i - 1 });
          namesById[id] = t;
        }
      }

      out.triggers.forEach(tr => {
        if (tr.targetSequenceId !== null && namesById[tr.targetSequenceId]) {
          tr.targetSequenceName = namesById[tr.targetSequenceId];
        }
      });

      // Route lookup for event decoding
      const flatRoute = {};
      Object.keys(out.routing).forEach(gid => {
        Object.assign(flatRoute, out.routing[gid].mappings);
      });

      headers.forEach(h => {
        const start = h.index;
        const numEvents = parseInt(s[start + 8], 10) || 0;
        const grpId = parseInt(s[start + 3], 10) || 0;
        const grpRoute = out.routing[grpId] ? out.routing[grpId].mappings : flatRoute;

        const events = [];
        let ptr = start + 9;
        for (let e = 0; e < numEvents && ptr + 5 < s.length; e++, ptr += 6) {
          events.push(decodeEvent({
            index: parseInt(s[ptr + 1], 10) || 0,
            frame: parseInt(s[ptr + 2], 10) || 0,
            cmd: parseInt(s[ptr + 3], 10) || 0,
            p1: parseInt(s[ptr + 4], 10) || 0,
            p2: parseInt(s[ptr + 5], 10) || 0
          }, { route: grpRoute, phrases: out.phrases, seqNames: namesById }));
        }

        events.sort((a, b) => a.frame - b.frame);

        out.sequences.push({
          id: h.id,
          name: h.name,
          priority: parseInt(s[start + 2], 10) || 0,
          groupId: grpId,
          groupName: out.groups[grpId] || (out.routing[grpId] ? out.routing[grpId].name : ('Group ' + grpId)),
          eventCount: events.length,
          events: events
        });
      });
    }

    // Q - parametric EQ registers (one or more profiles, each of 30-reg banks)
    // Format per profile: index, name, bankCount, magic-u16, then reg:value pairs
    // in ascending DSP-address order. Values are 7-bit with midscale 0x40 = 0 dB.
    out.equalizerProfiles = [];
    out.equalizer = [];
    if (sections.Q) {
      const q = sections.Q;
      let i = 0;
      const n = q.length;
      while (i < n) {
        const t = q[i].trim();
        if (isTerminator(t, '-2000')) break;
        const index = parseInt(t, 10);
        if (isNaN(index)) break;
        const name = (q[i + 1] || '').trim();
        const declaredBanks = parseInt(q[i + 2], 10) || 0;
        i += 4; // skip index, name, bankCount, magic

        const pairs = [];
        while (i < n) {
          const line = q[i];
          const t = line.trim();
          if (isTerminator(line, '-2000')) break;
          if (t === '-1' || t === '-1:') { i++; break; }
          const m = line.match(/(\d+):(\d+)/g);
          if (!m) { i++; continue; }
          m.forEach(pair => {
            const sp = pair.split(':');
            const reg = parseInt(sp[0], 10);
            const val = parseInt(sp[1], 10);
            if (!isNaN(reg) && !isNaN(val)) pairs.push({ reg, value: val });
          });
          i++;
          if (/-\s*1\s*:?\s*$/.test(t)) break;
        }

        // Split the ordered pairs into 30-register banks (the DSP address
        // template is identical for every bank; banks are stored back to back).
        const banks = [];
        for (let b = 0; b * 30 < pairs.length; b++) {
          const slice = pairs.slice(b * 30, b * 30 + 30);
          banks.push({
            id: b,
            registers: slice.map(p => ({
              reg: p.reg,
              value: p.value,
              signed: p.value - 64 // offset-binary: 0x40 = 0 dB
            }))
          });
        }

        banks.forEach(bank => {
          bank.registers.forEach(r => {
            out.equalizer.push({ register: r.reg, value: r.value, signed: r.signed, profile: index, bank: bank.id });
          });
        });

        out.equalizerProfiles.push({
          index,
          name,
          declaredBanks,
          banks,
          note: index === 0 && declaredBanks > banks.length
            ? 'Only ' + banks.length + ' bank(s) stored for this profile'
            : ''
        });
      }
    }

    // Derive the 3-zone onboard DSP model from the first EQ profile.
    // The register banks map to three speaker zones, each a 6-band filter
    // chain (register offset 0/1/6/7 carry the four band gains, 13/28 the
    // low/high cutoff). Values are 7-bit offset-binary with 0x40 = 0 dB and a
    // full-scale swing of +/-15 dB.
    (function buildZones() {
      const primary = out.equalizerProfiles[0];
      if (!primary) return;

      primary.banks.forEach(function (bank) {
        bank.registers.forEach(function (r) {
          if (!(r.reg in out.eqRegisterMap)) out.eqRegisterMap[r.reg] = r.value;
        });
      });

      const regMap = out.eqRegisterMap;
      const get = function (reg) { return (reg in regMap) ? regMap[reg] : 64; };
      const toDb = function (v) { return +(((v - 64) * (15 / 64)).toFixed(1)); };

      const ZONE_DEFS = [
        { number: 1, name: 'Zone 1: Front Headrests', target: 'Vocals & Leads', base: 6, sub: false },
        { number: 2, name: 'Zone 2: Rear Fill', target: 'Rhythm & Ambiance', base: 48, sub: false },
        { number: 3, name: 'Zone 3: Subwoofers', target: 'Bass & Seat Shakers', base: 90, sub: true }
      ];

      out.eqZones = ZONE_DEFS.map(function (def) {
        const rawHpf = get(def.base + 28);
        const rawLpf = get(def.base + 13);
        const hpf = def.number === 1 ? 80 : (rawHpf < 30 ? 60 : 30);
        const lpf = def.sub ? 140 : (rawLpf === 0 ? 12000 : 18000);

        return {
          zoneNumber: def.number,
          name: def.name,
          target: def.target,
          baseRegister: def.base,
          bands: [
            { id: 0, name: 'High-Pass (low cut)', type: 'highpass', freq: hpf, gain: 0, q: 0.707, enabled: true },
            { id: 1, name: 'Low Shelf (bass)', type: 'lowshelf', freq: 200, gain: toDb(get(def.base)), raw: get(def.base), q: 0.707, enabled: true },
            { id: 2, name: 'Low-Mid (parametric)', type: 'peaking', freq: 500, gain: toDb(get(def.base + 1)), raw: get(def.base + 1), q: 1.2, enabled: true },
            { id: 3, name: 'High-Mid (parametric)', type: 'peaking', freq: 2800, gain: toDb(get(def.base + 6)), raw: get(def.base + 6), q: 1.4, enabled: true },
            { id: 4, name: 'High Shelf (treble)', type: 'highshelf', freq: 6000, gain: toDb(get(def.base + 7)), raw: get(def.base + 7), q: 0.707, enabled: true },
            { id: 5, name: 'Low-Pass (treble kill)', type: 'lowpass', freq: lpf, gain: 0, q: 0.707, enabled: def.sub }
          ]
        };
      });
    }());

    // Keep raw text for every section (incl. undecoded C, E, M, F, A)
    const raw = {};
    Object.keys(sections).forEach(k => { raw[k] = sections[k].slice(0); });
    out.rawSections = raw;

    return out;
  }

  return {
    decode: decode,
    buildAudacityProject: buildAudacityProject,
    smpte: smpte,
    timeShort: timeShort,
    RELAY_NAMES: RELAY_NAMES,
    OPCODES: OPCODES,
    EQ_MIDSCALE: 64,
    EQ_BANK_SIZE: 30
  };
}));