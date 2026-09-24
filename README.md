# Genshin Build Checker

Cek build karakter Genshin Impact dari UID (Enka.Network) lawan standar komunitas (KQM), lengkap dengan
kalkulator damage offline, rotasi tim dari notasi KQM, DPS, dan benchmark "berapa % build-mu dari build standar".

Tanpa database, tanpa AI di jalur utama — semua data referensi adalah JSON statis di repo, semua angka dihitung kode.
LLM (DeepSeek, opsional) cuma buat verdict naratif dan pemilihan buff kalau diminta (`--llm`).

> Personal project, bahasa output Indonesia. Detail per fase: [`docs/project-breakdown.md`](docs/project-breakdown.md).

## Fitur

| Fitur | Perintah | Keterangan |
|---|---|---|
| Cek build vs KQM | `check <uid> <char>` / `enka <uid>` | ER requirement, rasio CR:CD, main stat per slot, substat priority, set, tier senjata → grade S–D |
| Benchmark | `benchmark <uid> <char>` | build-mu vs build acuan (artifact diganti standar KQMS, sisanya sama) → rasio + stat yang ketinggalan |
| Damage per hit | `damage <uid> <char>` | tabel non-crit/crit/avg tiap hit, baseline vs dengan buff tim/asumsi, rotasi, DPS |
| Rotasi tim | `rotation <uid> "<notasi KQM>"` | tiap karakter dihitung dengan tim = yang lain; buff support cuma nyala kalau aksinya ada; total tim + DPS |
| Brief AI | `assess <uid> <char> [--llm]` | semua data + hasil cek + guide mentah; `--llm` = verdict dari LLM |
| Planner primogem | `primo <YYYY-MM-DD>` | estimasi primo/fate sampai tanggal target (daily, Welkin, BP per level, Stardust, Abyss/Theater/Stygian, kode+kompensasi patch) → berapa wish. Income event **tidak** dihitung |
| UI | `http://localhost:4000` | 1 halaman statis, 3 tab: Karakter · Rotasi Tim · Primogem |

Mekanik yang dimodelkan: reaksi amplifying/additive/transformative, **Stellar-Conduct** (koefisien Polestar Field,
bonus kelas Stellar), **Lunar-Charged** (proc per aplikasi, kontributor dirangking, direct Lunar), uptime buff dari
durasi/CD talent, batas aksi berurutan (Decoding Power Sandrone), kit yang di-rework (Yae 6.7) lewat override.

## Instalasi

Prasyarat: **Docker Desktop** (Windows: butuh WSL2) dan **Git**. Node **tidak** perlu di host — semuanya jalan di
container. Semua data referensi (guide KQM, dump genshin-db, buff) sudah ada di repo; mapping Enka di-download
otomatis saat pertama jalan.

```powershell
git clone https://github.com/mchabib/genshin-build-checker.git
cd genshin-build-checker
copy backend\.env.example backend\.env    # Linux/macOS: cp backend/.env.example backend/.env
```

Edit `backend/.env`:
- `ENKA_USER_AGENT` — wajib diganti ke nama proyek + kontakmu (Enka.Network minta User-Agent yang jelas).
- `LLM_ENABLED` — **default `false`**. Biarin mati kalau di-hosting, biar kuota API-mu nggak kepakai orang lain.
  Nyalain cuma kalau kamu butuh `--llm`: `LLM_ENABLED=true` **dan** isi `LLM_API_KEY`. Semua kalkulator tetap jalan tanpa ini
  (kontrol LLM di UI otomatis disembunyiin kalau mati).

```powershell
docker compose up -d --build              # pertama kali ±1–2 menit (install dependency di container)
curl http://localhost:4000/api/health     # {"status":"ok","characters":...,"guides":...}
```

UI: **http://localhost:4000**. CLI lewat wrapper `gbc.ps1` (Windows; nyalain container kalau belum jalan) atau
langsung `docker compose exec backend npm run cli -- <perintah>` (semua OS):

```powershell
.\gbc.ps1 enka <uid>
docker compose exec backend npm run cli -- enka <uid>    # setara, tanpa wrapper
```

Kalau ganti `package.json` (dependency): `docker compose up -d --build` lagi; kalau volume `node_modules` basi:
`docker compose rm -sf backend; docker volume rm <project>_backend_node_modules; docker compose up -d --build`.

## Perintah

```powershell
.\gbc.ps1 enka <uid>
.\gbc.ps1 check <uid> alhaitham [--er "<label>"] [--build <n>]
.\gbc.ps1 benchmark <uid> yelan [--build <n>] [--er <label> | --er-target 130]
.\gbc.ps1 damage <uid> xiao [--team furina,faruzan] [--reaction vaporize] [--no-assume] [--rotation "E 9[N1C] Q"] [--duration 20]
.\gbc.ps1 rotation <uid> "Yae 3[E] > Qiqi E > Odette 2[E] > Sandrone 3[C E]" --enemy-lvl 100 --enemy-res 10
.\gbc.ps1 rotation <uid> "Ineffa E > Columbina E > Furina E > Yelan 2[E]" --duration 20
.\gbc.ps1 primo 2026-11-04 --welkin --bp paid --bp-level 12 --stardust --abyss 36 --theater visionary --stygian hard
```

Flag umum: `--enemy-lvl` (default 90) · `--enemy-res` (persen, default 10) · `--no-assume` (matikan buff kondisional
yang diasumsikan aktif) · `--stellar-hits 0–12` (koefisien Stellar-Conduct, default 8) · `--team none` (paksa solo) ·
`--json`.

### Notasi rotasi

Notasi quickhand KQM: `N3` = 3 normal attack, `C` = charged, `E`/`Q` = skill/burst, `hP`/`lP` = plunge, `k[...]` = ulang
k kali, `>` = ganti karakter. Arti satu aksi per karakter (mis. `E` Yae = tembakan turret, `C` Sandrone = sweeping +
3 beam) ada di modul karakter (`actions`), termasuk proc reaksi yang dipicu aksi itu (`react:lunarCharged`) dan batas
aksi berurutan (`limits`).

Durasi rotasi dihitung dari tabel durasi per token (`_durations.json`) — buat komposisi yang semua summon/off-field
(cast 5 detik tapi rotasi 20 detik) pakai `--duration 20`.

## Seberapa akurat?

Diadu dengan DPS meter in-game (musuh Lv 100, RES 10%):

| Tim | Real | Program (maks) | Catatan |
|---|---|---|---|
| Yae C1 · Odette · Sandrone · Qiqi (Stellar-Conduct), 22s | 2.364.007 | 2.415.287 (+2%) | per karakter ±8%; per hit cocok sampai 3 digit |
| Ineffa · Columbina · Furina · Yelan C1 (Lunar-Charged), 20s | 1.23–1.53 jt (2 run) | 1.55 jt / 1.14 jt tanpa asumsi | Ineffa & Columbina ±3%; nilai proc yang dikreditkan ke Furina belum dipahami |

Reaksi klasik (vaporize, aggravate, overloaded, …) pakai rumus standar tapi **belum** diadu in-game. Yang paling sering
meleset dari pengalaman kalibrasi bukan rumus, tapi: jumlah hit/tick summon, stat yang ternyata **tidak** masuk total
Enka (passive senjata/karakter tertentu), dan kit yang sudah di-rework tapi dump datanya lama.

Range "tanpa asumsi" → "maks" adalah bagian dari output, bukan bug: yang real biasanya di antaranya.

## Sumber data

| Data | Sumber | Lokasi | Refresh |
|---|---|---|---|
| Build user (stat total, artifact, senjata, C, talent) | Enka.Network `/api/uid/{uid}` | `backend/.cache/enka/uid-*.json` (TTL 90s) | otomatis |
| Mapping avatarId → nama/elemen/senjata | Enka store GitHub + koreksi dari genshin-db | `.cache/enka/`, `scrape-data/enka-store-{extra,overrides}.json` | 7 hari / `dump:gdb` |
| Guide & benchmark (ER, main stat, substat priority, set, senjata, combo, tim) | KQM quick guides | `scrape-data/Character/<slug>.json` (raw + parsed) | `npm run scrape:kqm` |
| Multiplier talent, passive, constellation, senjata, set | `genshin-db` (npm) | `scrape-data/Talents\|Weapons\|Artifacts/` | `npm run dump:gdb` |
| **Data tangan**: buff karakter/set/senjata/tim, durasi, standar benchmark, mekanik | ditulis manual, format di [`scrape-data/Buffs/_README.md`](backend/scrape-data/Buffs/_README.md) | `scrape-data/Buffs/` | — |
| **Data tangan**: income primogem (reward per sumber, jadwal patch) | ditulis manual, format di [`scrape-data/Primogems/_README.md`](backend/scrape-data/Primogems/_README.md) | `scrape-data/Primogems/` | — |

Prinsip: **pembaca dipisah dari data**. Scraper cuma nulis file; refresh KQM/genshin-db tidak butuh perubahan kode.
Data tangan hanya di `Buffs/` & `Primogems/`; scraper tidak pernah menyentuhnya.

```powershell
docker compose exec backend npm run scrape:kqm            # semua guide KQM (atau: ... scrape:kqm furina yelan)
docker compose exec backend npm run dump:gdb              # talent/senjata/set dari genshin-db
docker compose restart backend
```

## Nambah karakter / buff

1. `docker compose exec backend npm run module:new -- <Key>` → scaffold `Buffs/<Key>.json` (daftar hit id, passive
   A1/A4 & C1–C6 sebagai entry `manual`, rotasi dari combo KQM, tim dari guide).
2. Isi angka di `mod` (boleh ekspresi `"= ..."` dengan `char`, `con`, `p()`, `tp()`, `tm()`, `team`, `wv()`, `meta()`),
   set `mode` (`always` / `assume` / `manual`), `actions`, `durations`, `limits`.
3. `npm run check:buffs` — validator: hit id, token notasi, nama set/senjata/karakter, field typo, ekspresi yang meledak.
4. `npm run snapshot:check` — lihat angka mana yang berubah; kalau memang disengaja `npm run snapshot:update`.

Kalau dump genshin-db belum punya kit terbaru (rework), hit tambahan didefinisikan di `src/data/talentOverrides.ts`.

## HTTP API

| Endpoint | Isi |
|---|---|
| `GET /api/health` | status + jumlah data yang ke-load |
| `GET /api/characters`, `/api/characters/:key` | daftar / detail + guide |
| `GET /api/enka/:uid` | showcase ter-normalisasi |
| `POST /api/check` | skor 1 build (manual atau dari Enka) |
| `GET /api/assess/:uid/:char?llm=1` | brief lengkap (+ verdict LLM) |
| `GET /api/damage/:uid/:char?team=&reaction=&rotation=&duration=&stellarHits=&noAssume=1` | tabel damage + rotasi + DPS |
| `GET /api/rotation/:uid?r=<notasi>&duration=&enemyLvl=&enemyRes=` | rotasi tim |
| `GET /api/benchmark/:uid/:char?build=&er=&erTarget=&full=1` | benchmark vs build acuan |
| `GET /api/primogems?to=&from=&welkin=&bp=&bpLevel=&stardust=&abyssStars=&theater=&stygian=` | estimasi income primogem → wish |
| `GET /api/primogems/sources` | angka & pilihan tier yang tersedia (buat dropdown UI) |
| `GET /api/history?token=…` | **privat** — riwayat UID yang pernah dicek + berapa kali. Butuh `ADMIN_TOKEN`; kosong = endpoint dikunci |

## Struktur

```
backend/
  public/index.html            UI statis
  scrape-data/
    Character/                 guide KQM (scraped)
    Talents|Weapons|Artifacts/ dump genshin-db (scraped)
    Buffs/                     DATA TANGAN: <Key>.json, _team/_sets/_weapons/_durations/_benchmark.json, _README.md
    Primogems/                 DATA TANGAN: _sources.json (income primogem, jadwal patch), _README.md
  scripts/                     scrape-kqm.mjs, dump-genshin-db.mjs
  src/
    cli.ts                     CLI (gbc.ps1 → npm run cli)
    routes/                    Express routes
    lib/                       talentLabel (label → hit), kqmCombo (notasi → hit/durasi/limits), stats
    data/                      stellar (koefisien/EM bonus), talentOverrides (kit rework), infusions, reactionLevelMultiplier
    services/
      enka.service/mapper      fetch + normalisasi Enka
      characterStore/guideStore/gameDataStore/buffStore   loader data
      scoring/check            cek build vs KQM (+ benchmark)
      benchmark.service        build acuan KQMS & rasio
      primogem.service         income primogem sampai tanggal target → wish
      damage.service           rumus murni (hit, reaksi, Stellar, Lunar)
      damage.run               orkestrasi 1 karakter (tim, buff, uptime, rotasi, DPS)
      rotation.run             rotasi tim
      buffCheck / moduleScaffold / snapshot   tooling data
    fixtures/                  fixture Enka + snapshot regresi (npm test)
    tools/                     check:buffs, module:new, snapshot
```

`npm test` = 49 test (parser, rumus, rules, benchmark, validator data, snapshot regresi angka damage 2 UID).

## Catatan

- Angka standar dari KQM; tabel ER yang formatnya rumit sengaja tidak di-parse (scorer nampilin teks aslinya).
- Fixture di `src/fixtures/enka/` adalah data showcase publik dari Enka (UID yang dipakai buat kalibrasi).
- `frontend/` (React) stale dan tidak dipakai — UI yang aktif ada di `backend/public/index.html`.
