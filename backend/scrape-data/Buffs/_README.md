# scrape-data/Buffs — buff terstruktur (jalur TANPA LLM)

Dibaca `src/services/buffStore.ts`. Format tiap entry = `Modifier` kalkulator
(`src/services/damage.types.ts`) + metadata. Angka boleh berupa **ekspresi** string
berawalan `=` yang dievaluasi saat runtime (biar ikut level talent / stat teammate):

```
"atkFlat": "= (tm('Bennett')?.baseAtk ?? 756) * (tp('Bennett','burst','param4') ?? 1.008)"
```

Variabel di ekspresi:
- `char`  — karakter yang dihitung: `char.final.{hp,atk,def,em,critRate,critDmg}`, `char.base.{hp,atk,def}`, `char.level`, `char.element`
- `con`, `er` — constellation & ER (%) karakter
- `p(slot, param)` — param talent karakter di level efektifnya (pecahan apa adanya, mis. 0.0626); slot `normal|skill|burst`
- `tp(key, slot, param)` — param talent teammate di level talent-nya (default lv10 kalau nggak di showcase)
- `tm(key)` — info teammate dari showcase (`baseAtk, em, con, talentLevels`) atau `null`
- `team.keys`, `team.elements` (elemen unik di tim termasuk karakter sendiri), `team.count`
- `meta(slot)` / `tmeta(key, slot)` — `{duration, cd}` detik dari label talent "Duration"/"CD" (karakter sendiri / teammate)
- `min, max, round, pct(x)` (= x×100)

## File
- `_team.json`   — buff dari teammate. `fromCharacter` = otomatis aktif kalau char itu ada di tim.
                    `assumeWith` = daftar key support yang bikin entry ini diasumsikan aktif (mis. VV 4pc kalau ada Kazuha).
- `_sets.json`   — 4pc set kondisional (`set` = nama set). `mode`: `always` (masuk baseline) | `assume` (dianggap aktif di mode offline, "asumsi max" ala Genshin Optimizer) | `manual` (cuma lewat `--catalog id` / LLM).
- `_weapons.json`— passive senjata kondisional (`weapon` = nama senjata). `mode` sama.
- `<Key>.json`   — modul per karakter: `role`, `self[]` (passive/E/Q/constellation kondisional, `mode` sama),
                    `reactions` (override rule), `rotations[]`, `teams[][]` (opsional; default diparse dari KQM).

## Field tambahan
- `hitLabelMatch` (di `mod`): regex ke LABEL hit, mis. `"Stellar-Conduct"` → buff cuma kena hit varian Stellar (dipakai set
  Disenchantment / Heart of the Furnace, Odette A4). Cocok buat sistem reaksi baru yang hit-nya punya multiplier sendiri.
- `requireSet` (entry self): butuh 4pc set ini terpasang (mis. Golden Troupe off-field bonus Yae).
- `naElements` (modul): override elemen NA/CA/plunge, mis. Sandrone `{"na":"physical","ca":"cryo"}`.
- `reactions.with.<elemen>: {}` (kosong) = "ada elemen ini di tim → JANGAN kasih reaksi generik" (tim Stellar).

## Karakter baru yang belum ada di store GitHub Enka
`npm run dump:gdb` juga nulis `scrape-data/enka-store-extra.json` (dari genshin-db) — mapping avatarId → nama buat
karakter yang repo docs Enka-nya telat. Nama senjata/set baru di-resolve dari `itemId` / icon (`UI_RelicIcon_<id>_`).

## `actions` — arti satu aksi (buat notasi KQM & rotasi tim)
```json
"actions": { "E": { "skill3": 5 }, "C": { "ca1": 1, "ca3": 4 }, "Q": { "burst1": 1, "burst3": 1 }, "N4": { "burst2": 1, ... } }
```
Dipakai waktu notasi diparse (`--rotation`, preset `kqm`, `rotation <uid> "..."`). Tanpa ini default: `E`/`Q` = semua hit
skill/burst 1×, `C` = ca1, `N#` = na1..na#. Wajib buat kit yang E-nya "summon yang nembak berkali-kali" (Yae, Fischl),
CA multi-hit (Sandrone), atau NA yang pindah slot (Raiden dalam Q → `N4` = burst2..burst5).

## `requiresAction` (entry `_team.json`)
`"requiresAction": "burst"` = di rotasi tim, buff ini cuma aktif kalau Q teammate itu muncul di urutan (Bennett Q, Furina Q);
`"skill"` buat E (Zhongli shield, Kazuha A4). Di `damage` biasa (tanpa urutan) tetap dianggap aktif.

## Rotasi
Urutan sumber: **preset modul → notasi combo dari guide KQM (otomatis) → generik 1× tiap hit**.
Preset modul boleh dua bentuk:
- `"counts": { "na1": 9, "ca1": 9, "burst2": 1 }` — hit id persis dari tabel (`damage <uid> <char>` nampilin id-nya)
- `"kqm": "E 8[N1C] Q"` — notasi quickhand KQM, diparse `src/lib/kqmCombo.ts`:
  `N3` = na1..na3 · `C` = ca1 · `hP`/`P`/`JP` = plunge_high · `lP` = plunge_low · `E` = semua hit skill 1× · `Q` = semua hit burst 1× ·
  `k[...]` = ulang k× · `D`/`J` = cancel (diabaikan).
  Pakai `counts` kalau `E`/`Q` punya varian hit yang nggak semuanya kena (Hu Tao burst1 vs burst2 low-HP, Clorinde skill1a/1b,
  Raiden NA dalam Q = burst2..). Tanpa preset, parser nyari baris notasi di section `combos`/`rotations` KQM dan
  angka pengulangan di prosa ("reach 9 N1C combos") — cek hasilnya, karena notasi di prosa kadang ambigu.

`mode: always` = pasti aktif saat nyerang (Hu Tao E ATK konversi). `assume` = kondisional tapi
wajar dianggap aktif (Vermillion 4 stack, Hu Tao A4 <50% HP). Nilai `uptime` 0-1 boleh dipakai buat rata-rata.

## Stellar Glimmer (Stellar-Conduct / Stellar Swirl)
Hit ber-label "… Stellar-Conduct DMG" / "… Stellar Swirl DMG" otomatis dihitung pakai rumus Stellar (`src/data/stellar.ts`,
sumber guide KQM): `ATK×MV × coef(hit terekam Polestar Field, 1.0–2.0) × (1 + EM bonus + stellarBonus) × RES × crit` —
**tanpa DEF musuh dan tanpa DMG% biasa** (goblet/Furina/dll nggak ngaruh). Buff yang "Stellar Glimmer DMG +x%" ditulis
sebagai `stellarBonus` di `mod` (bukan `dmgBonus` + `hitLabelMatch`). Polestar Field ke tim = entry `polestar_field`
di `_team.json`. Jumlah hit terekam: `--stellar-hits` (default 8 = ×1.8).

## Tooling
- `npm run check:buffs` — validasi semua file di folder ini (JSON, hit id, token notasi/durasi, nama set/senjata/karakter,
  field `mod` typo, ekspresi meledak termasuk saat teammate nggak ada di showcase → `tm()` null). Jalan juga di `npm test`.
- `npm run module:new -- <Key|nama>` — scaffold `<Key>.json`: `_hits` (referensi id hit), entry A1/A4/C1–C6 `mode: manual`
  dengan deskripsi asli (isi angkanya), rotasi dari notasi combo KQM, tim dari guide. `--force` buat nimpa.
- `npm run snapshot:check` / `snapshot:update` — regresi angka damage dari fixture Enka (`src/fixtures/`). Habis ngubah
  data di sini, cek diff-nya masuk akal lalu update.
- `_benchmark.json` — standar build acuan buat `benchmark` (lihat komentar di file).

## Waktu: durasi rotasi, DPS, uptime nyata
- `_durations.json` — detik per token notasi: `default` + per tipe senjata (`sword|claymore|polearm|bow|catalyst`).
  `N#` = kumulatif sampai hit ke-#. Modul boleh override lewat `durations` (key sama dengan `actions`, mis. Yae `"E": 0.9`).
- Durasi rotasi: `--duration` → `rotations[].duration` (wajib buat preset bentuk `counts`) → dihitung dari notasi × tabel.
  `rotation <uid> "..."` menjumlahkan durasi semua segmen = durasi tim → DPS tim.
- Uptime nyata: entry (`_team`/`_sets`/`_weapons`/modul) boleh punya `duration` dan `cooldown` (angka atau `"= ..."`).
  Kalau durasi rotasi diketahui: `uptime = (uptime statis ?? 1) × min(1, duration / max(rotasi, cooldown))`.
  `uptime` statis jadi "efektivitas rata-rata saat aktif" (Furina Fanfare 0.8). Kalau rotasi < cooldown ada catatan
  "nggak bisa tiap rotasi". Di rotasi tim jendelanya = durasi seluruh tim, bukan segmen si support.
- Entry `_team.json` dengan `fromCharacter` + `requiresAction` tanpa `duration`: otomatis pakai label "Duration"/"CD"
  talent E/Q teammate (Bennett Q 12s/15s, Faruzan Q 12s/20s). Label lain ("Shield Duration") sengaja nggak — isi manual
  (Zhongli shield `duration: 20, cooldown: 12`).
