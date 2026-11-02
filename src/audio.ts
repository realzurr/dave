import { SoundEffectDef } from './types';

export type AudioStyle = 'MODERN' | 'CLASSIC';

export class PCSpeakerAudio {
  private ctx: AudioContext | null = null;
  private sounds = new Map<number, SoundEffectDef>();
  private currentPriority = -1;
  private currentSoundId = 0;
  private stopTimer: number | null = null;
  private activeOsc: OscillatorNode | null = null;
  private activeGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  // Background Music (Synthwave procedural sequencer)
  private bgmTimer: number | null = null;
  private bgmStep = 0;
  public bgmEnabled = true;

  public muted = false;
  public style: AudioStyle = 'MODERN';

  constructor(soundList: SoundEffectDef[]) {
    for (const s of soundList) {
      this.sounds.set(s.id, s);
    }
  }

  private ensureContext(): AudioContext | null {
    if (this.muted) return null;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
      this.createNoiseBuffer(this.ctx);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  private createNoiseBuffer(ctx: AudioContext): void {
    const bufferSize = ctx.sampleRate * 1.5;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    this.noiseBuffer = buffer;
  }

  public startBgm(): void {
    if (this.bgmTimer !== null) return;
    const stepMs = 135; // ~111 BPM 16th notes
    this.bgmTimer = window.setInterval(() => {
      if (this.muted || !this.bgmEnabled || this.style !== 'MODERN') return;
      const ctx = this.ensureContext();
      if (!ctx) return;
      this.playBgmStep(ctx, this.bgmStep++);
    }, stepMs);
  }

  public stopBgm(): void {
    if (this.bgmTimer !== null) {
      window.clearInterval(this.bgmTimer);
      this.bgmTimer = null;
    }
  }

  private playBgmStep(ctx: AudioContext, step: number): void {
    const now = ctx.currentTime;
    const barStep = step % 64;

    // Synthwave Bassline (A minor -> F major -> G major -> E minor)
    const bassRoots = [55, 55, 43.65, 49]; // A1, A1, F1, G1
    const root = bassRoots[Math.floor(barStep / 16)];
    const bassFreq = barStep % 2 === 0 ? root : root * 2;

    const bassOsc = ctx.createOscillator();
    const bassFilter = ctx.createBiquadFilter();
    const bassGain = ctx.createGain();
    bassOsc.type = 'sawtooth';
    bassOsc.frequency.setValueAtTime(bassFreq, now);
    bassFilter.type = 'lowpass';
    bassFilter.frequency.setValueAtTime(360, now);
    bassFilter.frequency.exponentialRampToValueAtTime(110, now + 0.11);
    bassGain.gain.setValueAtTime(0.035, now);
    bassGain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    bassOsc.connect(bassFilter);
    bassFilter.connect(bassGain);
    bassGain.connect(ctx.destination);
    bassOsc.start(now);
    bassOsc.stop(now + 0.12);

    // Kick on 0, 4, 8, 12
    if (barStep % 4 === 0) {
      const kickOsc = ctx.createOscillator();
      const kickGain = ctx.createGain();
      kickOsc.type = 'sine';
      kickOsc.frequency.setValueAtTime(130, now);
      kickOsc.frequency.exponentialRampToValueAtTime(32, now + 0.11);
      kickGain.gain.setValueAtTime(0.08, now);
      kickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      kickOsc.connect(kickGain);
      kickGain.connect(ctx.destination);
      kickOsc.start(now);
      kickOsc.stop(now + 0.12);
    }

    // Melodic Arp Lead
    const arpNotes = [
      220, 261.63, 329.63, 440, 329.63, 261.63, 329.63, 392,
      174.61, 220, 261.63, 349.23, 196, 246.94, 293.66, 392,
    ];
    if (barStep % 2 === 0) {
      const note = arpNotes[(barStep / 2) % arpNotes.length] * (barStep >= 32 ? 1.5 : 1);
      const leadOsc = ctx.createOscillator();
      const leadGain = ctx.createGain();
      leadOsc.type = 'triangle';
      leadOsc.frequency.setValueAtTime(note, now);
      leadGain.gain.setValueAtTime(0.022, now);
      leadGain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      leadOsc.connect(leadGain);
      leadGain.connect(ctx.destination);
      leadOsc.start(now);
      leadOsc.stop(now + 0.18);
    }
  }

  public stop(): void {
    if (this.stopTimer !== null) {
      window.clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    if (this.activeOsc) {
      try {
        this.activeOsc.stop();
        this.activeOsc.disconnect();
      } catch {
        // ignore
      }
      this.activeOsc = null;
    }
    if (this.activeGain) {
      try {
        this.activeGain.disconnect();
      } catch {
        // ignore
      }
      this.activeGain = null;
    }
    this.currentPriority = -1;
    this.currentSoundId = 0;
  }

  public stopIfPlaying(soundId: number): void {
    if (this.currentSoundId === soundId) {
      this.stop();
    }
  }

  /**
   * Plays either Modern Polyphonic Synth SFX or Classic 1990 PC Speaker SFX.
   */
  public play(soundId: number, force = false, combo = 1): void {
    if (this.muted) return;

    if (this.style === 'MODERN') {
      this.playModernSfx(soundId, combo);
      return;
    }

    this.playClassicPCSpeaker(soundId, force);
  }

  /**
   * Custom modern sounds for new mechanics (Dash, Laser Shoot, Combo Pickup).
   */
  public playDash(): void {
    if (this.muted) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    // Sub whoosh + filtered noise burst
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(580, now);
    osc.frequency.exponentialRampToValueAtTime(95, now + 0.16);
    gain.gain.setValueAtTime(0.11, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.17);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.17);

    if (this.noiseBuffer) {
      const noise = ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(1800, now);
      filter.frequency.exponentialRampToValueAtTime(400, now + 0.15);
      const nGain = ctx.createGain();
      nGain.gain.setValueAtTime(0.09, now);
      nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
      noise.connect(filter);
      filter.connect(nGain);
      nGain.connect(ctx.destination);
      noise.start(now);
      noise.stop(now + 0.16);
    }
  }

  public playShoot(): void {
    if (this.muted) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(1350, now);
    osc.frequency.exponentialRampToValueAtTime(140, now + 0.14);
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(3200, now);
    filter.Q.value = 4;
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.15);
  }

  private playModernSfx(soundId: number, combo = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    switch (soundId) {
      case 1: {
        // HitWall: Low thud
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(150, now);
        osc.frequency.exponentialRampToValueAtTime(45, now + 0.08);
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.09);
        break;
      }
      case 4: {
        // Walking: Subtle soft tap
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(110 + Math.random() * 25, now);
        osc.frequency.exponentialRampToValueAtTime(55, now + 0.035);
        gain.gain.setValueAtTime(0.035, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.04);
        break;
      }
      case 5: {
        // Jumping: Crisp modern upward sweep
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(210, now);
        osc.frequency.exponentialRampToValueAtTime(640, now + 0.14);
        gain.gain.setValueAtTime(0.11, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.15);
        break;
      }
      case 6: {
        // Treasure: Shimmering crystal chime with combo pitch boost
        const mult = Math.min(2.0, 1 + (combo - 1) * 0.12);
        const freqs = [587.33 * mult, 880 * mult, 1174.66 * mult];
        freqs.forEach((f, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'triangle';
          const t = now + idx * 0.045;
          osc.frequency.setValueAtTime(f, t);
          gain.gain.setValueAtTime(0.1, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(t);
          osc.stop(t + 0.22);
        });
        break;
      }
      case 7: {
        // GotTrophy: Epic synth fanfare
        const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
        notes.forEach((f, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sawtooth';
          const filter = ctx.createBiquadFilter();
          filter.type = 'lowpass';
          filter.frequency.value = 2600;
          const t = now + idx * 0.08;
          osc.frequency.setValueAtTime(f, t);
          gain.gain.setValueAtTime(0.09, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
          osc.connect(filter);
          filter.connect(gain);
          gain.connect(ctx.destination);
          osc.start(t);
          osc.stop(t + 0.45);
        });
        break;
      }
      case 8: {
        // Explosion: Deep sub-bass punch + filtered noise blast
        const sub = ctx.createOscillator();
        const subGain = ctx.createGain();
        sub.type = 'sine';
        sub.frequency.setValueAtTime(120, now);
        sub.frequency.exponentialRampToValueAtTime(24, now + 0.45);
        subGain.gain.setValueAtTime(0.22, now);
        subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.46);
        sub.connect(subGain);
        subGain.connect(ctx.destination);
        sub.start(now);
        sub.stop(now + 0.46);

        if (this.noiseBuffer) {
          const noise = ctx.createBufferSource();
          noise.buffer = this.noiseBuffer;
          const filter = ctx.createBiquadFilter();
          filter.type = 'lowpass';
          filter.frequency.setValueAtTime(1400, now);
          filter.frequency.exponentialRampToValueAtTime(160, now + 0.5);
          const nGain = ctx.createGain();
          nGain.gain.setValueAtTime(0.18, now);
          nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.52);
          noise.connect(filter);
          filter.connect(nGain);
          nGain.connect(ctx.destination);
          noise.start(now);
          noise.stop(now + 0.52);
        }
        break;
      }
      case 9: {
        // Flying! (Jetpack thruster pulse)
        if (this.noiseBuffer) {
          const noise = ctx.createBufferSource();
          noise.buffer = this.noiseBuffer;
          const filter = ctx.createBiquadFilter();
          filter.type = 'bandpass';
          filter.frequency.setValueAtTime(420, now);
          const nGain = ctx.createGain();
          nGain.gain.setValueAtTime(0.045, now);
          nGain.gain.exponentialRampToValueAtTime(0.005, now + 0.09);
          noise.connect(filter);
          filter.connect(nGain);
          nGain.connect(ctx.destination);
          noise.start(now);
          noise.stop(now + 0.09);
        }
        break;
      }
      case 10: {
        // NextLevel: Portal warp victory chord
        const chord = [440, 554.37, 659.25, 880, 1108.73, 1318.51];
        chord.forEach((f, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'triangle';
          const t = now + idx * 0.07;
          osc.frequency.setValueAtTime(f, t);
          gain.gain.setValueAtTime(0.1, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(t);
          osc.stop(t + 0.55);
        });
        break;
      }
      case 11:
      case 12: {
        // Powerup / Jetpack / Gun pickup: Sci-fi power-up riser
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(260, now);
        osc.frequency.exponentialRampToValueAtTime(1040, now + 0.25);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.26);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.26);
        break;
      }
      default:
        // Fallback to classic for any other ID
        this.playClassicPCSpeaker(soundId, true);
        break;
    }
  }

  private playClassicPCSpeaker(soundId: number, force = false): void {
    const def = this.sounds.get(soundId);
    if (!def || def.divisors.length === 0) return;

    if (!force && this.currentPriority > def.priority) {
      return;
    }

    const ctx = this.ensureContext();
    if (!ctx) return;

    this.stop();
    this.currentPriority = def.priority;
    this.currentSoundId = soundId;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    gain.gain.value = 0;
    osc.connect(gain);
    gain.connect(ctx.destination);

    const stepSec = 1 / (18.2065 * Math.max(1, def.timerRate));
    const now = ctx.currentTime;

    for (let i = 0; i < def.divisors.length; i++) {
      const div = def.divisors[i];
      const t = now + i * stepSec;
      if (div > 0 && div < 0xfffe) {
        const freq = Math.min(12000, Math.max(40, 1193181 / div));
        osc.frequency.setValueAtTime(freq, t);
        gain.gain.setValueAtTime(0.08, t);
      } else {
        gain.gain.setValueAtTime(0, t);
      }
    }

    const totalSec = def.divisors.length * stepSec;
    gain.gain.setValueAtTime(0, now + totalSec);
    osc.start(now);
    osc.stop(now + totalSec + 0.01);

    this.activeOsc = osc;
    this.activeGain = gain;

    this.stopTimer = window.setTimeout(() => {
      this.currentPriority = -1;
      this.currentSoundId = 0;
      this.stopTimer = null;
    }, totalSec * 1000);
  }
}
