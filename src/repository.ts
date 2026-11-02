import { HighScoreEntry } from './types';

export interface SaveStateRecord {
  id: string;
  name: string;
  level: number;
  score: number;
  lives: number;
  hasGun: boolean;
  hasTrophy: boolean;
  jetpackFuel: number;
  inWarpZone: boolean;
  daveX: number;
  daveY: number;
  scrollX: number;
  savedAt: string;
}

const LS_HIGHSCORES_KEY = 'ddave_highscores';
const LS_SAVES_KEY = 'ddave_saves';

export class LocalDataRepository {
  /**
   * Loads High Scores from the local disk repository (/api/repository/highscores)
   * with fallback to localStorage and initial DSCORES.DAV data.
   */
  public async getHighScores(fallback: HighScoreEntry[]): Promise<HighScoreEntry[]> {
    try {
      const res = await fetch('/api/repository/highscores');
      if (res.ok) {
        const list: HighScoreEntry[] = await res.json();
        if (Array.isArray(list) && list.length > 0) {
          localStorage.setItem(LS_HIGHSCORES_KEY, JSON.stringify(list));
          return list;
        }
      }
    } catch {
      // Offline / static build fallback
    }

    const saved = localStorage.getItem(LS_HIGHSCORES_KEY);
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        // ignore
      }
    }
    return fallback.map((h) => ({ ...h }));
  }

  /**
   * Saves High Scores to both localStorage and the local disk repository
   * (data/highscores.json + binary DSCORES.DAV).
   */
  public async saveHighScores(scores: HighScoreEntry[]): Promise<void> {
    localStorage.setItem(LS_HIGHSCORES_KEY, JSON.stringify(scores));
    try {
      await fetch('/api/repository/highscores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scores),
      });
    } catch {
      // Ignore if running without dev server middleware
    }
  }

  /**
   * Loads Save States from the local disk repository (data/saves.json)
   * with fallback to localStorage.
   */
  public async getSaves(): Promise<SaveStateRecord[]> {
    try {
      const res = await fetch('/api/repository/saves');
      if (res.ok) {
        const list: SaveStateRecord[] = await res.json();
        if (Array.isArray(list)) {
          localStorage.setItem(LS_SAVES_KEY, JSON.stringify(list));
          return list;
        }
      }
    } catch {
      // fallback
    }

    const saved = localStorage.getItem(LS_SAVES_KEY);
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        // ignore
      }
    }
    return [];
  }

  /**
   * Persists a Save State slot to data/saves.json on disk and localStorage.
   */
  public async saveGameSlot(slot: SaveStateRecord): Promise<SaveStateRecord[]> {
    const existing = await this.getSaves();
    const idx = existing.findIndex((s) => s.id === slot.id);
    if (idx >= 0) existing[idx] = slot;
    else existing.unshift(slot);
    const trimmed = existing.slice(0, 20);
    localStorage.setItem(LS_SAVES_KEY, JSON.stringify(trimmed));

    try {
      const res = await fetch('/api/repository/saves', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(slot),
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.saves)) return data.saves;
      }
    } catch {
      // fallback
    }
    return trimmed;
  }
}
