# Dangerous Dave (1990) — Engenharia Reversa & Edição Web

Port completo para Web (HTML5 Canvas + TypeScript + Web Audio API) construído a partir da engenharia reversa direta dos arquivos binários originais de MS-DOS de **Dangerous Dave (1990)**, criado por John Romero / Softdisk, Inc.

---

## Estrutura do Repositório

- `DAVE.EXE` (`76.586 bytes`): Executável DOS original compactado com **LZEXE 0.91** (`LZ91`).
- `EGADAVE.DAV` (`86.332 bytes`): Sprites e tiles em formato planar EGA de 16 cores.
- `DSCORES.DAV` (`45 bytes`): Tabela binária de recordes (*High Scores*), sincronizada automaticamente com o jogo Web.
- `scripts/extract.mjs`: Descompactador LZ91 + extrator RLE que gera:
  - `extracted/DAVE_UNPACKED.BIN`: Imagem binária descompactada (`172.336 bytes`).
  - `extracted/sprites/vga/*.png`: Todos os 158 tiles e sprites VGA com máscaras AND de transparência aplicadas.
  - `extracted/sprites/ui/*.png`: Ícones do painel de controle Softdisk.
  - `extracted/levels/level_1.json` .. `level_10.json`: Mapas `100x10`, rotas de patrulha `(dx, dy)` e spawns dos monstros.
  - `extracted/sounds/sounds.json`: Os 12 efeitos sonoros do PC Speaker extraídos do bloco `SPK\0` (`0x1C2E0`).
  - `public/assets/gamedata.json`: Bundle unificado carregado pelo motor Web.
- `data/`: Repositório local de persistência em disco (`highscores.json` e `saves.json`), servido e sincronizado via middleware em `vite.config.ts` (`/api/repository/*`) e `src/repository.ts`.
- `src/`: Motor completo do jogo Web (`engine.ts`, `renderer.ts`, `audio.ts`, `repository.ts`, `main.ts`).

---

## Mapa de Memória do `DAVE.EXE` Descompactado (`172.336 bytes`)

| Offset Linear | Segmento | Descrição |
| :--- | :--- | :--- |
| `0x00000 .. 0x0B30F` | `CS = 0x0000` | Código x86 16-bit do motor do jogo |
| `0x0C420 .. 0x11EEF` | `0x0C42:0000` | Tiles e Sprites CGA comprimidos em RLE (`27.818 bytes` descomprimido) |
| `0x11EF0 .. 0x1C2DF` | `0x11EF:0000` | Tiles e Sprites VGA comprimidos em RLE (`71.238 bytes` descomprimido, 158 entradas) |
| `0x1C2E0 .. 0x1D57F` | `0x1C2E:0000` | Bloco `SPK\0` com 12 efeitos sonoros de PC Speaker (divisores PIT 8253) |
| `0x20CC0 .. 0x254CF` | `0x20CC:0000` | Fonte VGA `8x8` (128 glifos) + 13 ícones de UI (`32x24`) |
| `0x2558C` | `DS:0x00BC` | Tabela de velocidades verticais do pulo (`jumpTable`) |
| `0x255F2 .. 0x25619` | `DS:0x0122` | Coordenadas iniciais `(X, Y)` do Dave para as Fases 1–10 |
| `0x2563A .. 0x25689` | `DS:0x016A` | Tabelas das 4 *Warp Zones* secretas (Fases 5, 8, 9 e 10) |
| `0x2570A .. 0x25731` | `DS:0x023A` | IDs de tiles coletáveis e valores de pontuação |
| `0x25732 .. 0x25805` | `DS:0x0262` | Tabelas de propriedades de tiles (escaláveis, sólidos e letais) |
| `0x25966 .. 0x25C85` | `DS:0x0496` | Registros de spawn de monstros (`10 x 80 bytes`) |
| `0x25CA6 .. 0x25CE9` | `DS:0x07D6` | Mapa `10x7` animado da tela título |
| `0x2690A .. 0x26C09` | `DS:0x143A` | Paleta VGA de 256 cores (`768 bytes`, RGB 6-bit) |
| `0x26C0A .. 0x29E09` | `DS:0x173A` | Mapas e caminhos de monstros das 10 fases (`10 x 1280 bytes`) |

---

## Comandos

```bash
# Re-extrair todos os assets binários de DAVE.EXE e DSCORES.DAV
npm run extract

# Iniciar servidor de desenvolvimento + API de repositório local
npm run dev

# Compilar versão de produção
npm run build
```
