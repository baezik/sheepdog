// Alert sounds, synthesised with Web Audio so Sheepdog ships no audio files.
'use strict';
window.SheepdogSounds = (() => {
  let ctx = null;
  const ac = () => (ctx ||= new AudioContext());

  function tone({ type = 'sine', from, to = from, start = 0, dur, gain = 0.3, vibrato = 0 }) {
    const c = ac();
    const t0 = c.currentTime + start;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(from, t0);
    o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    if (vibrato) {
      const lfo = c.createOscillator();
      const lg = c.createGain();
      lfo.frequency.value = 9; lg.gain.value = vibrato;
      lfo.connect(lg).connect(o.frequency);
      lfo.start(t0); lfo.stop(t0 + dur);
    }
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(c.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }

  const sounds = {
    Woof() { // two short, low, falling barks
      for (const s of [0, 0.22]) { tone({ type: 'sawtooth', from: 320, to: 140, start: s, dur: 0.14, gain: 0.22 }); tone({ type: 'square', from: 180, to: 90, start: s, dur: 0.12, gain: 0.08 }); }
    },
    Ding() { tone({ from: 1318, dur: 0.9, gain: 0.25 }); tone({ from: 2636, dur: 0.5, gain: 0.06 }); },
    Bleat() { tone({ type: 'sawtooth', from: 420, to: 380, dur: 0.6, gain: 0.15, vibrato: 25 }); },
    Silent() {},
  };

  return {
    play(name) {
      try { if (ac().state === 'suspended') ac().resume(); (sounds[name] || sounds.Ding)(); } catch {}
    },
    names: Object.keys(sounds),
  };
})();
