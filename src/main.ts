import { PCSpeakerAudio } from './audio';
import { DaveEngine } from './engine';
import { VGARenderer } from './renderer';
import { GameDataBundle } from './types';

async function bootstrap() {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  const res = await fetch('/assets/gamedata.json');
  const gameData: GameDataBundle = await res.json();

  const renderer = new VGARenderer(canvas);
  await renderer.loadAssets(gameData);

  const audio = new PCSpeakerAudio(gameData.sounds);
  const engine = new DaveEngine(gameData, renderer, audio);

  // Expose engine on window for console inspection
  (window as unknown as { daveEngine: DaveEngine }).daveEngine = engine;

  // ==========================================================================
  // Keyboard Input Handling
  // ==========================================================================
  const updateKey = (code: string, pressed: boolean) => {
    switch (code) {
      case 'ArrowLeft':
      case 'KeyA':
        engine.keys.left = pressed;
        break;
      case 'ArrowRight':
      case 'KeyD':
        engine.keys.right = pressed;
        break;
      case 'ArrowUp':
      case 'KeyW':
        engine.keys.up = pressed;
        break;
      case 'ArrowDown':
      case 'KeyS':
        engine.keys.down = pressed;
        break;
      case 'Space':
        engine.keys.jump = pressed;
        break;
      case 'ControlLeft':
      case 'ControlRight':
      case 'KeyZ':
        engine.keys.shoot = pressed;
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
      case 'KeyC':
        engine.keys.dash = pressed;
        break;
    }
  };

  window.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'F1', 'F3', 'F5', 'F7', 'F9'].includes(e.code)) {
      e.preventDefault();
    }
    if (e.code === 'F5') {
      engine.quickSave().then(() => audio.play(12, true));
      return;
    }
    if (e.code === 'F7') {
      engine.repo.getSaves().then((saves) => {
        if (saves.length > 0) {
          engine.loadSaveSlot(saves[0]);
          audio.play(6, true);
        }
      });
      return;
    }
    if (e.code === 'KeyM' && engine.state !== 'HIGH_SCORE_ENTRY') {
      toggleMute();
      return;
    }
    updateKey(e.code, true);
    engine.handleKeyDown(e);
  });

  window.addEventListener('keyup', (e) => {
    updateKey(e.code, false);
  });

  // ==========================================================================
  // Toolbar & Remaster Controls UI
  // ==========================================================================
  const btnVisualStyle = document.getElementById('btn-visual-style')!;
  const btnAudioStyle = document.getElementById('btn-audio-style')!;
  const btnBgm = document.getElementById('btn-bgm')!;
  const btnHelp = document.getElementById('btn-help')!;
  const btnRestart = document.getElementById('btn-restart')!;
  const btnMute = document.getElementById('btn-mute')!;
  const btnCrt = document.getElementById('btn-crt')!;
  const btnDevtools = document.getElementById('btn-devtools')!;
  const btnCloseDevtools = document.getElementById('btn-close-devtools')!;
  const devtoolsPanel = document.getElementById('devtools-panel')!;
  const canvasWrap = document.getElementById('canvas-wrap')!;

  btnVisualStyle.addEventListener('click', () => {
    renderer.style = renderer.style === 'MODERN' ? 'CLASSIC' : 'MODERN';
    const isModern = renderer.style === 'MODERN';
    btnVisualStyle.textContent = isModern ? '✨ Visual: Moderno HD' : '🕹️ Visual: Clássico 1990';
    btnVisualStyle.classList.toggle('active', isModern);
    canvasWrap.classList.toggle('modern-glow', isModern);
  });

  btnAudioStyle.addEventListener('click', () => {
    audio.style = audio.style === 'MODERN' ? 'CLASSIC' : 'MODERN';
    const isModern = audio.style === 'MODERN';
    btnAudioStyle.textContent = isModern ? '🎹 Áudio: Synth Moderno' : '📟 Áudio: PC Speaker 1990';
    btnAudioStyle.classList.toggle('active', isModern);
    audio.startBgm();
  });

  btnBgm.addEventListener('click', () => {
    audio.bgmEnabled = !audio.bgmEnabled;
    if (audio.bgmEnabled) audio.startBgm();
    btnBgm.textContent = audio.bgmEnabled ? '🎵 Música: ON' : '🎵 Música: OFF';
    btnBgm.classList.toggle('active', audio.bgmEnabled);
  });

  btnHelp.addEventListener('click', () => {
    engine.helpPage = (engine.helpPage + 1) % 4;
  });

  btnRestart.addEventListener('click', () => {
    engine.startNewGame(0);
  });

  document.getElementById('btn-quicksave')!.addEventListener('click', async () => {
    await engine.quickSave();
    audio.play(12, true);
  });

  document.getElementById('btn-quickload')!.addEventListener('click', async () => {
    const saves = await engine.repo.getSaves();
    if (saves.length > 0) {
      engine.loadSaveSlot(saves[0]);
      audio.play(6, true);
    }
  });

  const toggleMute = () => {
    audio.muted = !audio.muted;
    if (audio.muted) audio.stop();
    btnMute.textContent = audio.muted ? '🔇 Som: OFF' : '🔊 Som: ON';
    btnMute.classList.toggle('active', !audio.muted);
  };
  btnMute.addEventListener('click', toggleMute);

  btnCrt.addEventListener('click', () => {
    canvasWrap.classList.toggle('crt');
    btnCrt.classList.toggle('active', canvasWrap.classList.contains('crt'));
  });

  btnDevtools.addEventListener('click', () => {
    devtoolsPanel.classList.toggle('hidden');
    btnDevtools.classList.toggle('active', !devtoolsPanel.classList.contains('hidden'));
  });

  btnCloseDevtools.addEventListener('click', () => {
    devtoolsPanel.classList.add('hidden');
    btnDevtools.classList.remove('active');
  });

  // Populate Level 1..10 buttons
  const levelGrid = document.getElementById('level-buttons')!;
  for (let i = 0; i < 10; i++) {
    const b = document.createElement('button');
    b.textContent = `Fase ${i + 1}`;
    b.addEventListener('click', () => {
      engine.startNewGame(i);
    });
    levelGrid.appendChild(b);
  }

  // Populate Warp Zone buttons (Levels 5, 8, 9, 10)
  const warpGrid = document.getElementById('warp-buttons')!;
  for (const lvlIdx of [4, 7, 8, 9]) {
    const b = document.createElement('button');
    b.textContent = `🌀 Warp Fase ${lvlIdx + 1}`;
    b.addEventListener('click', () => {
      engine.startNewGame(lvlIdx);
      engine.jumpToWarpZone(lvlIdx);
    });
    warpGrid.appendChild(b);
  }

  // Cheats
  document.getElementById('btn-give-jetpack')!.addEventListener('click', () => {
    engine.dave.jetpackFuel = 255;
    audio.play(12, true);
  });
  document.getElementById('btn-give-gun')!.addEventListener('click', () => {
    engine.dave.hasGun = true;
    audio.play(12, true);
  });
  document.getElementById('btn-give-trophy')!.addEventListener('click', () => {
    engine.dave.hasTrophy = true;
    audio.play(7, true);
  });
  const btnGod = document.getElementById('btn-godmode')!;
  btnGod.addEventListener('click', () => {
    engine.godMode = !engine.godMode;
    btnGod.textContent = `🛡️ God Mode: ${engine.godMode ? 'ON' : 'OFF'}`;
    btnGod.classList.toggle('active', engine.godMode);
  });

  // Populate Sound Synthesizer buttons
  const soundGrid = document.getElementById('sound-buttons')!;
  for (const s of gameData.sounds) {
    const b = document.createElement('button');
    b.textContent = `#${s.id} ${s.name}`;
    b.title = `Rate: ${s.sampleRateHz}Hz | Samples: ${s.divisors.length}`;
    b.addEventListener('click', () => {
      audio.play(s.id, true);
    });
    soundGrid.appendChild(b);
  }

  // Populate 158 VGA Sprite Gallery
  const gallery = document.getElementById('sprite-gallery')!;
  for (const sp of gameData.sprites) {
    if (sp.id === 0) continue;
    const card = document.createElement('div');
    card.className = 'sprite-card';
    card.title = `Sprite #${sp.id} (${sp.width}x${sp.height})${sp.isMask ? ' [AND-MASK]' : ''}`;
    const img = document.createElement('img');
    img.src = sp.dataUrl;
    const lbl = document.createElement('span');
    lbl.textContent = `#${sp.id}`;
    card.appendChild(img);
    card.appendChild(lbl);
    gallery.appendChild(card);
  }

  const telemetryEl = document.getElementById('debug-telemetry')!;
  const updateTelemetry = () => {
    if (devtoolsPanel.classList.contains('hidden')) return;
    const col = Math.floor(engine.dave.worldX / 16);
    const row = Math.floor((engine.dave.y - 16) / 16);
    telemetryEl.innerHTML = [
      `State: ${engine.state} | Level: ${engine.currentLevel + 1}${engine.inWarpZone ? ' (WARP ZONE)' : ''}`,
      `Dave World: (${engine.dave.worldX.toFixed(1)}, ${engine.dave.y.toFixed(1)}) | Grid: (${col}, ${row})`,
      `CameraX: ${engine.cameraX.toFixed(1)}px | Combo: x${engine.comboCount}`,
      `Dash CD: ${engine.dave.dashCooldown} | Particles: ${engine.particles.length}`,
    ].join('<br/>');
  };

  // ==========================================================================
  // Main Game Loop (60 Hz Continuous Physics + 60 FPS Render)
  // ==========================================================================
  const TICK_MS = 1000 / 60; // 16.67ms (60 FPS smooth physics)
  let lastTime = performance.now();
  let accumulator = 0;

  const loop = (now: number) => {
    const dt = Math.min(100, now - lastTime);
    lastTime = now;
    accumulator += dt;

    while (accumulator >= TICK_MS) {
      engine.step();
      accumulator -= TICK_MS;
    }

    engine.render();
    updateTelemetry();
    requestAnimationFrame(loop);
  };

  requestAnimationFrame(loop);
}

bootstrap().catch((err) => {
  console.error('Failed to bootstrap Dangerous Dave Remaster:', err);
});
