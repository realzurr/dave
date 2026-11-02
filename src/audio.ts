import { SoundEffectDef } from './types';

export class PCSpeakerAudio {
  private ctx: AudioContext | null = null;
  private sounds = new Map<number, SoundEffectDef>();
  private currentPriority = -1;
  private currentSoundId = 0;
  private stopTimer: number | null = null;
  private activeOsc: OscillatorNode | null = null;
  private activeGain: GainNode | null = null;
  public muted = false;

  constructor(soundList: SoundEffectDef[]) {
    for (const s of soundList) {
      this.sounds.set(s.id, s);
    }
  }

  private ensureContext(): AudioContext | null {
    if (this.muted) return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
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
        // ignore if already stopped
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
   * Plays one of the 12 extracted PC Speaker sounds (1..12) from DAVE.EXE (0x1c2e0):
   *  1: HitWall
   *  2: Falling
   *  3: OUCH!
   *  4: Walking
   *  5: Jumping
   *  6: Treasure
   *  7: GotTrophy
   *  8: explosion
   *  9: Flying!
   * 10: NextLevel
   * 11: ToJetpack
   * 12: GotSomethng
   */
  public play(soundId: number, force = false): void {
    if (this.muted) return;
    const def = this.sounds.get(soundId);
    if (!def || def.divisors.length === 0) return;

    // Priority check matching DAVE.EXE (0x7450: cmp al, [138a]; jb skip)
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
