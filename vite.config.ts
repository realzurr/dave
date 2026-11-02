import fs from 'fs';
import path from 'path';
import { defineConfig, Plugin } from 'vite';

interface HighScoreRecord {
  rank: number;
  score: number;
  level: number;
  name: string;
  updatedAt?: string;
}

interface SaveSlot {
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

function localDataRepositoryPlugin(): Plugin {
  const dataDir = path.resolve(process.cwd(), 'data');
  const highScoresPath = path.join(dataDir, 'highscores.json');
  const savesPath = path.join(dataDir, 'saves.json');
  const dscoresBinaryPath = path.resolve(process.cwd(), 'DSCORES.DAV');

  const ensureDataFiles = () => {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    if (!fs.existsSync(highScoresPath)) {
      const initial: HighScoreRecord[] = [];
      if (fs.existsSync(dscoresBinaryPath)) {
        const hsBuf = fs.readFileSync(dscoresBinaryPath);
        for (let i = 0; i < 5 && (i + 1) * 9 <= hsBuf.length; i++) {
          const rec = hsBuf.subarray(i * 9, (i + 1) * 9);
          const level = rec[0];
          const score =
            rec[1] * 10000 +
            rec[2] * 1000 +
            rec[3] * 100 +
            rec[4] * 10 +
            rec[5];
          const name = rec.subarray(6, 9).toString('ascii').replace(/\0.*$/, '');
          initial.push({ rank: i + 1, score, level, name });
        }
      }
      fs.writeFileSync(highScoresPath, JSON.stringify(initial, null, 2));
    }
    if (!fs.existsSync(savesPath)) {
      fs.writeFileSync(savesPath, JSON.stringify([], null, 2));
    }
  };

  /**
   * Writes top 5 high scores back into the 45-byte DOS binary DSCORES.DAV format
   * so the original DOS game and the Web game share the exact same high scores!
   */
  const syncBinaryDscores = (scores: HighScoreRecord[]) => {
    const buf = Buffer.alloc(45, 0);
    for (let i = 0; i < 5; i++) {
      const entry = scores[i] || { level: 1, score: 100, name: 'JON' };
      const base = i * 9;
      buf[base + 0] = Math.max(1, Math.min(99, entry.level));
      const clamped = Math.max(0, Math.min(99999, Math.floor(entry.score)));
      const s = clamped.toString().padStart(5, '0');
      buf[base + 1] = s.charCodeAt(0) - 48;
      buf[base + 2] = s.charCodeAt(1) - 48;
      buf[base + 3] = s.charCodeAt(2) - 48;
      buf[base + 4] = s.charCodeAt(3) - 48;
      buf[base + 5] = s.charCodeAt(4) - 48;
      const cleanName = (entry.name || 'DAV').toUpperCase().padEnd(3, ' ').slice(0, 3);
      buf.write(cleanName, base + 6, 3, 'ascii');
    }
    fs.writeFileSync(dscoresBinaryPath, buf);
  };

  return {
    name: 'ddave-local-data-repository',
    configureServer(server) {
      ensureDataFiles();

      server.middlewares.use('/api/repository', (req, res, next) => {
        ensureDataFiles();
        res.setHeader('Content-Type', 'application/json');

        const url = req.url || '/';

        if (req.method === 'GET' && (url === '/' || url === '/status')) {
          const highScores = JSON.parse(fs.readFileSync(highScoresPath, 'utf8'));
          const saves = JSON.parse(fs.readFileSync(savesPath, 'utf8'));
          res.end(
            JSON.stringify({
              ok: true,
              dataDir,
              files: {
                highScores: highScoresPath,
                saves: savesPath,
                binaryDscores: dscoresBinaryPath,
              },
              highScores,
              saves,
            })
          );
          return;
        }

        if (req.method === 'GET' && url === '/highscores') {
          res.end(fs.readFileSync(highScoresPath, 'utf8'));
          return;
        }

        if (req.method === 'POST' && url === '/highscores') {
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', () => {
            try {
              const incoming: HighScoreRecord[] = JSON.parse(body);
              fs.writeFileSync(highScoresPath, JSON.stringify(incoming, null, 2));
              syncBinaryDscores(incoming);
              res.end(JSON.stringify({ ok: true, highScores: incoming }));
            } catch (err) {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: String(err) }));
            }
          });
          return;
        }

        if (req.method === 'GET' && url === '/saves') {
          res.end(fs.readFileSync(savesPath, 'utf8'));
          return;
        }

        if (req.method === 'POST' && url === '/saves') {
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', () => {
            try {
              const slot: SaveSlot = JSON.parse(body);
              const saves: SaveSlot[] = JSON.parse(fs.readFileSync(savesPath, 'utf8'));
              const idx = saves.findIndex((s) => s.id === slot.id);
              if (idx >= 0) saves[idx] = slot;
              else saves.unshift(slot);
              fs.writeFileSync(savesPath, JSON.stringify(saves.slice(0, 20), null, 2));
              res.end(JSON.stringify({ ok: true, saves }));
            } catch (err) {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: String(err) }));
            }
          });
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [localDataRepositoryPlugin()],
});
