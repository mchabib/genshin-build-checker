# Genshin Build Checker — Project Breakdown

Personal web project: cek standarisasi build karakter Genshin Impact (artifact substat, damage rotasi, dll). Dikerjakan bertahap per fase, **tiap fase di chat terpisah** biar fokus dan context gak numpuk.

---

## Fase 1: Artifact Substat Checker  ← scope saat ini

**Tujuan:** Quick win, user bisa cek apakah substat artifact karakternya udah sesuai standar umum (bukan berdasar damage hitungan, tapi threshold komunitas).

**Data source:**
- Manual input form (nama char, main stat weapon, substat artifact), dan/atau
- Enka.Network API (fetch showcase build dari UID publik user)

**Komponen:**
- Database benchmark substat per karakter per role (DPS / sub-DPS / support) — referensi tier list komunitas (Genshin Optimizer, KQM)
- Logic scoring sederhana: CRIT Rate:CRIT DMG ratio (idealnya 1:2), EM threshold (reaction build), ER requirement, dll
- Output: pass/fail per substat + rekomendasi singkat

**Stack (final):**
- Backend: Node + TypeScript + Express (proxy Enka API karena CORS + rate limit) — **fokus utama**
- Data: **JSON statis** hasil scrape KQM (`backend/scrape-data/Character/`), tanpa database
- Interface: CLI (`gbc.ps1`) + HTTP API
- Deploy: Docker Compose (1 service)
- Frontend: sempat dibuat (React + Vite + Tailwind) tapi **di-deprioritize**, sekarang stale

---

## Fase 2: Damage Calculator Hybrid (deterministik + LLM) — SELESAI 2026-09-10

**Tujuan (diperluas dari rencana awal):** tabel damage per hit + rotasi sederhana yang memperhitungkan passive, constellation, senjata, set, **team comp**, dan **semua reaksi** — untuk semua 107 karakter yang punya data.

**Update 2026-09-10 (sore): jalur OFFLINE jadi default, LLM opsional.** User mau logika jalan tanpa AI.
Keputusan tim/buff/reaksi/rotasi sekarang dari data `scrape-data/Buffs/` (modul per karakter + `_team/_sets/_weapons.json`,
angka boleh ekspresi `= ...` yang dievaluasi `buffStore.ts`) + rule `damage.rules.ts` (tim dari preset modul / parse baris
"A — B — C — D" KQM, reaksi dari elemen tim, rotasi preset, buff `mode: assume` dianggap aktif ala GO). `role` modul dipakai
scorer Fase 1. LLM tetap tersedia lewat `--llm` dan pakai katalog yang sama (`catalogId`). Modul tersedia: 12 roster user + Hu Tao,
Yoimiya, Wriothesley; karakter lain jalan dengan set/senjata/tim generik + catatan.

**Arsitektur hybrid — kode menghitung, LLM menalar (jalur opsional):**
- **Deterministik (`damage.service.ts`, pure):** semua angka. Input = stat total Enka + base stat (fightProp 1/4/7) + multiplier talent.
- **LLM (`damage.llm.ts`, DeepSeek default / OpenAI-compatible apa pun):** cuma memutuskan *buff kondisional mana yang aktif*, *tim* (kalau user nggak kasih), *reaksi per jenis hit*, dan *combo rotasi*. Output JSON divalidasi zod + di-cap (anti-halusinasi), lalu kode menghitung ulang. Tanpa `LLM_API_KEY` semuanya tetap jalan.
- **Katalog buff (`data/buffCatalog.ts`):** ground truth ber-`id` (Bennett Q, Kazuha A4, VV, Zhongli shield, Furina Q, Emblem 4pc, Hu Tao E, Raiden resolve/C2, …). Self-buff `auto` masuk baseline; LLM menyebut `catalogId` supaya angkanya dari katalog, bukan tebakan.

**Sumber data:** `genshin-db` (devDependency) di-dump sekali via `npm run dump:gdb` → `scrape-data/Talents|Weapons|Artifacts/*.json` (attributes verbatim; parser label di `lib/talentLabel.ts` + koreksi `data/talentOverrides.ts`). Runtime cuma baca JSON (`gameDataStore.ts`).

**Rumus (persen = angka persen; Enka sudah termasuk stat statis):**
```
ATK   = enka.atk + baseATK·ΣatkPct + ΣatkFlat + ΣatkFromStat (HP/DEF/EM → ATK, cap)   (HP/DEF analog)
base  = Σ mult_i(lvl)·(1+talentMultBonus) + talentMultAdd) · Stat_i + flatDmg
add   = aggravate 1.15 / spread 1.25 : levelMult(Lv)·rMult·(1 + 5·EM/(EM+1200) + rBonus)
amp   = vaporize (pyro 1.5 / hydro 2) · melt (pyro 2 / cryo 1.5) : rMult·(1 + 2.78·EM/(EM+1400) + rBonus)
nonCrit = (base + add) · (1 + DMG%[elemen]) · defMult · resMult · amp
defMult = (Lv+100) / ((Lv+100) + (LvEnemy+100)·(1−defShred)·(1−defIgnore))
resMult = res<0 ? 1−res/2 : res<0.75 ? 1−res : 1/(4res+1)
crit = ×(1+CD) ; avg = ×(1 + min(CR,1)·CD)
transformative = levelMult(Lv)·rMult·(1 + 16·EM/(EM+2000) + rBonus)·resMult   (baris terpisah, per proc)
```
Default musuh Lv 90, RES 10%. Level multiplier reaksi di `data/reactionLevelMultiplier.ts`.

**Surface:**
- CLI `damage <uid> <char> [--team a,b,c] [--reaction vaporize | ca=vaporize,na=none] [--enemy-lvl] [--enemy-res] [--catalog id,id] [--rotation na1=3,ca1=2] [--no-llm] [--json] [--show-prompt]`
- `GET /api/damage/:uid/:char?team=&reaction=&enemyLvl=&enemyRes=&catalog=&llm=0`
- `assess --llm` / `GET /api/assess/:uid/:char?llm=1` → verdict format (b) dari LLM (Tahap B dari Fase 1).
- UI `public/index.html`: section "Damage" + tombol verdict LLM.
- Test: `npm test` (parser label, rumus, schema/validasi LLM, retry client dengan fetch mock).

**Limitasi yang disengaja:** nggak ada ICD/timing (LLM yang menentukan jumlah proc di rotasi), uptime buff = skala linear, buff dari LLM adalah aproksimasi (selalu ada baseline deterministik sebagai pembanding), lunar reactions belum, label multiplier "X% Normal Attack DMG" (Wanderer/Yoimiya/Wriothesley) dimodelkan sebagai `talentMultBonus` di katalog.

---

**Fase 2 DITUTUP 2026-09-11.** Sudah termasuk (melampaui rencana awal): semua reaksi, buff tim/set/senjata, katalog JSON,
character module (`scrape-data/Buffs/`), jalur offline default + LLM opsional, rotasi dari notasi KQM (1 karakter & tim,
`rotation <uid> "..."`, buff support aktif hanya kalau aksinya ada di urutan, `actions` per modul), fallback karakter baru
di luar store Enka. Diuji di 2 akun (815634265: 12 char; 817613918: Yae/Sandrone/Odette/Qiqi). 33 test.

---

## Fase 3: Waktu, Benchmark, Tooling Data

Reaksi, buff stacking, character module, dan rotasi tim sudah ada dari Fase 2. Fase 3 = yang tersisa supaya
hasilnya *detail tanpa LLM*:

1. **Waktu / DPS** — tabel durasi per aksi (per karakter, default generik) → durasi rotasi, DPS, **uptime buff nyata**
   (Bennett Q 12s dari rotasi 21s), peringatan kalau rotasi nggak muat di durasi buff/field time.
2. **Benchmark (ala Akasha)** — rotasi & tim sama, build acuan dari main stat + substat standar KQM → skor relatif
   ("build kamu = 87% dari standar"). Ini inti tujuan proyek: cek standarisasi build.
3. **Tooling data** — `check:buffs` (validasi hit id/ekspresi/catalogId + snapshot regresi total), `module:new <Key>`
   (scaffold modul dari hit list + passive + combo/tim KQM), lalu perluas modul/`actions`/constellation sesuai showcase.
4. Sumber data lebih dalam kalau perlu (Dimbreath/AnimeGameData) buat mekanik baru yang angkanya belum di genshin-db
   (Polestar Field / Stellar Glimmer, Lunar).

**Status 2026-09-11 — 1–3 SELESAI, 4 ditunda (belum dibutuhkan).**

- **Snapshot regresi:** fixture Enka 2 UID di `src/fixtures/enka/` (env `ENKA_FIXTURE_DIR`), `npm run snapshot:update|check`,
  test `damage.snapshot.test.ts` (total rotasi + avg per hit + daftar modifier, toleransi 0.5%).
- **Waktu/DPS:** `scrape-data/Buffs/_durations.json` (detik per token notasi, default + per tipe senjata, N# kumulatif) +
  `durations` per modul + `rotations[].duration` buat preset `counts`. `Rotation.timing {duration, dps, source, rows}`;
  `--duration`; `rotation` tim = jumlah segmen → DPS tim. **Uptime nyata:** entry buff boleh punya `duration`/`cooldown`
  (angka/ekspresi) atau otomatis dari label "Duration"/"CD" talent teammate (`bennett_q` 12s/15s, `faruzan_q` 12s/20s) →
  `uptime = (statis ?? 1) × min(1, durasi / max(rotasi, CD))`, catatan kalau CD > rotasi. Di rotasi tim jendelanya durasi tim.
- **Benchmark:** `benchmark.service.ts` + `_benchmark.json` (KQMS: 20 roll tetap + 20 bebas, cap 2/artifact). Acuan =
  build user dengan artifact diganti (main stat guide KQM, ER ke requirement dulu, lalu substat priority, CR:CD dijaga 1:2);
  stat non-artifact diturunkan dari Enka (`total − artifact user`). Tim/rotasi/reaksi/durasi disamakan. Output rasio +
  delta stat + verdict. Masuk ke `check` sebagai "Benchmark vs standar KQMS" (≥90% pass, 75–90 warn; role non-DPS = info),
  CLI `benchmark <uid> <char>`, `GET /api/benchmark/:uid/:char`, brief `assess`, UI bar + tabel delta.
- **Tooling:** `npm run check:buffs` (validator, jalan di `npm test`; langsung nemu 2 error data lama), `npm run module:new -- <Key>`
  (scaffold modul dari dump + KQM). Data ditambah: senjata Kagura/Haran/Teaspoon/Bloodsoaked, set Desert Pavilion/Noblesse 2pc/
  Night of the Sky's Unveiling, Golden Troupe 2pc dibenerin (+20 skill), `actions`/`durations` Neuvillette/Furina/Chasca/Yelan/Xiao/Zhongli.
- Test 47. Hasil benchmark UID 815634265: 86–120% dari standar (Yelan 86% CR 52 vs 88, Furina 88%).

**Kalibrasi in-game (11–12 Sep 2026, DPS meter stage latihan, Lv 100 RES 10%):**
- Tim Stellar-Conduct (Yae C1/Odette/Sandrone/Qiqi C6): real 2.364M vs program 2.415M (+2%). Yang ketemu: rumus hit
  Stellar (tanpa DEF, koefisien Polestar 1.0–2.0, bonus kelas Stellar), Teaspoon ATK +28% & Sandrone A4 EM +160 **tidak**
  di Enka, Haran +12% **sudah** di Enka, kit Yae 6.7 (dump genshin-db basi → `talentOverrides`), Sandrone 3 beam/CA +
  Decoding Power (`limits`), label "DoT" Odette.
- Tim Lunar-Charged (Ineffa/Columbina/Furina/Yelan C1): real 1.23–1.53M vs program 1.55M maks / 1.14M no-assume. Proc
  LC = tiap aplikasi (33/20s), dikreditkan ke pemicu; per-proc 19.95k vs real ≈19.6k. Salon Furina 5/12/4 hit per 20s
  (solo 265k vs 254k). Belum dipahami: nilai proc yang dikreditkan ke Furina (~7k, bukan 20k).

**Limitasi yang tersisa:** Lunar-Bloom/Lunar-Crystallize belum; reaksi klasik belum diadu in-game; durasi aksi kasar (±0.2s, per tipe senjata); durasi preset `counts` = aproksimasi tangan;
KQMS = standar "wajar", build endgame biasanya >100%; ER target hilang kalau tabel ER KQM nggak keparse (`--er-target`);
Lunar/Polestar/Stellar buff tim (`odette_q_stellar`) masih placeholder; 2pc set yang nggak ada di fightProp Enka
(Skill/Burst DMG%) cuma kehitung kalau 4pc terpasang.

---

## Catatan

- Tantangan utama bukan cuma teknis, tapi nentuin "standar" yang valid — beda karakter beda kebutuhan stat, dan komunitas punya beberapa versi benchmark (KQM vs Genshin Optimizer beda approach).
- Kerjakan per fase di chat terpisah.
