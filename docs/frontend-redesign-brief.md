# Brief: Redesign Frontend — Genshin Build Checker

## Konteks proyek

Backend + CLI Node/TypeScript/Express yang cek build karakter Genshin Impact dari UID (Enka.Network) lawan
standar komunitas (KQM), plus kalkulator damage offline, rotasi tim, benchmark, dan planner primogem.
Semua logic udah jalan dan teruji (64 test) — **tugas sesi baru ini murni tampilan (frontend), bukan logic baru.**

Repo: https://github.com/mchabib/genshin-build-checker

## Yang ada sekarang

**File tunggal**: `backend/public/index.html` (818 baris) — HTML + CSS + JS vanilla dalam satu file, di-serve
langsung sama Express (`express.static`), **tanpa build step, tanpa framework**. Ada juga folder `frontend/`
(React + Vite + Tailwind) tapi itu **stale/bengong**, jangan dipakai atau dilanjutin — types-nya udah nggak
sesuai schema backend.

Tema sekarang: dark mode polos, palet abu-abu-biru (`--bg:#0e0e12 --panel:#17171f --text:#e7e7ea`), functional
tapi generik — belum ada identitas visual yang nyambung ke Genshin Impact.

### 3 tab yang ada

1. **Karakter** — input UID → grid kartu karakter dari showcase Enka → klik kartu → hasil: grade S-D,
   checklist (ER, CR:CD ratio, main stat, substat, set, senjata), section **Benchmark** (bar % vs build
   standar KQM + tabel delta stat + selector build/ER), tabel artifact, opsional verdict LLM (disembunyikan
   otomatis kalau `LLM_ENABLED=false` di server).
2. **Rotasi Tim** — input notasi combo KQM (`"Yae 3[E] > Qiqi E > Odette 2[E] > Sandrone 3[C E]"`), chip nama
   karakter buat bantu ngetik, kontrol (Lv musuh, RES%, durasi, stellar-hits, asumsi on/off) → hasil per
   karakter (subtotal + bar share%, buff aktif, tabel hit) + total tim + DPS.
3. **Primogem** — planner income primo: tanggal dari-sampai, checkbox Welkin/Stardust, dropdown BP/Theater/
   Stygian, level BP, bintang Abyss → tabel breakdown per sumber + total wish. **Tidak butuh UID.**

### Endpoint API yang dipakai UI (semua GET kecuali disebut)

```
GET /api/enka/:uid                          → { player, characters[], meta }
GET /api/assess/:uid/:char?llm=0|1          → { character, weapon, stats, deterministic (checks[]), benchmark, guide, artifacts[] }
GET /api/benchmark/:uid/:char?build=&erTarget=  → { ratio, status, deltas[], reference{mains,substats}, build }
GET /api/damage/:uid/:char?team=&reaction=&rotation=&duration=&stellarHits=&noAssume=1&llm=0|1
                                             → { character, enemy, team, reactions, modifiers[], baseline, buffed, rotation, llm, warnings }
GET /api/rotation/:uid?r=<notasi>&duration=&enemyLvl=&enemyRes=
                                             → { characters[] (tiap ada .report = damage report di atas), lunar?, total, dps, warnings }
GET /api/primogems?to=&from=&welkin=&bp=&bpLevel=&stardust=&abyssStars=&theater=&stygian=
                                             → { rows[], totalPrimogems, totalFates, wishes, patches[] }
GET /api/primogems/sources                  → { battlePass.tiers, cycles.theater.tiers, cycles.stygian.tiers, patch.anchor }
GET /api/health                             → { status, characters, guides, llm:{enabled,reason} }
```

Baca `backend/public/index.html` sekarang buat lihat persis field apa yang dipakai dari tiap respons (fungsi
`render()`, `damage()`, `rotation()`, `primogems()`) — itu kontrak yang harus tetap dipenuhi kalau strukturnya
diubah.

## Tujuan sesi ini

Bikin ulang **tampilan** (HTML/CSS, boleh JS-nya dirapiin juga) biar terasa lebih "Genshin" dan lebih enak
dipakai — **tanpa mengubah backend/API**. Fokus:

1. **Identitas visual** — nuansa yang kerasa genshin (bukan niru asetnya, tapi mood-nya): elegan, sedikit
   fantasy, palet warna elemen (Pyro/Hydro/Electro/dst) dipakai buat aksen (badge elemen karakter, dsb),
   tipografi yang rapi. Boleh gradient halus, boleh kartu dengan sedikit glow, hindari yang norak.
2. **Hierarki informasi lebih jelas** — grade S/A/B/C/D, angka benchmark %, dan total DPS/wish itu "hasil
   utama" yang harus langsung kelihatan, bukan tenggelam di antara detail.
3. **Kartu karakter lebih hidup** — showcase Enka ngasih `element`, `weaponType`, `constellation`, `sets[]`;
   pakai buat bikin kartu yang informatif at-a-glance (warna aksen per elemen, ikon simple/emoji cukup).
4. **Rotasi Tim & Primogem dirapikan** — dua tab ini paling "form-heavy" sekarang, kurang enak dipandang.
5. **Mobile-friendly** — banyak yang bakal buka dari HP. Breakpoint yang ada sekarang (`@media max-width:640px`)
   cuma nge-reflow grid, belum dites serius di layar sempit.
6. **Ringan** — tetap 1 file HTML/CSS/JS vanilla, **tanpa build step, tanpa framework baru**. CDN buat font
   (Google Fonts) atau ikon (mis. lucide/phosphor via CDN) boleh, tapi jangan nambah dependency npm/bundler.

## Batasan keras (jangan dilanggar)

- **Satu file** `backend/public/index.html`, di-serve statis oleh Express — nggak ada build step, nggak ada
  React/Vue/dst. Kalau mau reorganisasi jadi lebih dari 1 file, itu perlu didiskusiin dulu (defaultnya: jangan).
- **Jangan ubah bentuk request/response API.** Semua field yang disebut di atas harus tetap dibaca & dipakai.
  Kalau nemu field yang keliatannya berguna tapi belum dipakai (mis. ada di respons tapi UI-nya nggak nampilin),
  boleh ditambahin ke UI — itu peningkatan, bukan pelanggaran.
- **Fitur yang harus tetap ada** (boleh dirapiin tampilannya, jangan dihapus): 3 tab, checklist grade, section
  benchmark + selector build/ER, tabel damage per hit (baseline vs buffed), tabel rotasi tim + breakdown per
  karakter, planner primogem lengkap dengan semua kontrolnya, tombol verdict LLM (tetap disembunyikan
  otomatis kalau `llmConfigured` dari `/api/health` bernilai false — lihat elemen `.llm-only` di kode sekarang).
- **Bahasa UI: Indonesia santai**, konsisten sama yang sekarang (mis. "Perlu dilihat" bukan "Warning").
- **Dark mode tetap default** (banyak yang buka malam-malam buat ngitung build), tapi kalau mau nambahin
  light mode toggle, silakan — bukan wajib.
- **Warna grade S/A/B/C/D dan status check (pass/warn/fail/info/skip) harus tetap gampang dibedain** — ini
  bukan cuma estetika, dipakai buat ambil keputusan cepat soal build.

## Yang bebas diubah

- Semua CSS/layout/warna/font/spacing.
- Struktur HTML di dalam tiap tab (asal data yang ditampilkan tetap lengkap).
- Cara render kartu karakter, tabel, dan bar (boleh ganti dari `<table>` ke card list kalau lebih rapi
  buat di HP, misalnya).
- Microinteraction ringan (transition, hover state, loading skeleton) — asal nggak butuh library JS baru.
- Menambah elemen visual baru (mis. badge elemen berwarna, ikon crit/EM, progress ring buat benchmark %)
  selama datanya emang ada di respons API.

## Referensi elemen Genshin (buat palet aksen, opsional dipakai)

| Elemen | Warna umum di komunitas |
|---|---|
| Pyro | merah-oranye `#ef4444` / `#f97316` |
| Hydro | biru `#3b82f6` / `#0ea5e9` |
| Electro | ungu `#a855f7` / `#c084fc` |
| Cryo | cyan muda `#67e8f9` / `#7dd3fc` |
| Anemo | teal/mint `#2dd4bf` |
| Geo | kuning keemasan `#eab308` |
| Dendro | hijau `#84cc16` / `#65a30d` |

## Cara jalanin buat dites

Backend butuh Node (Docker opsional, tapi biasanya Docker Desktop nggak nyala di mesin ini — cek dulu,
kalau nggak jalan pakai Node langsung di host):

```powershell
cd D:\docker\Genshin\backend
npm install        # sekali aja
npm run dev         # → http://localhost:4000, auto-reload
```

UID contoh buat testing (data publik Enka, dipakai buat kalibrasi proyek ini): pin UID Genshin Impact
sendiri, atau cari UID publik lain untuk dites — cukup UID 9-10 digit yang showcase-nya aktif & bukan private.

Endpoint `/api/primogems` nggak butuh UID sama sekali, cocok buat tes UI Primogem duluan tanpa nunggu Enka.

## Saran urutan kerja

1. Baca `backend/public/index.html` penuh dulu — pahami struktur JS-nya (fungsi `render`, `renderGrid`,
   `damage`, `rotation`, `primogems`, `benchmark`) sebelum ngubah markup, biar event listener-nya nggak putus.
2. Desain ulang design token dulu (CSS variables `:root`) — palet warna, spacing scale, radius, shadow.
3. Rombak tab **Karakter** dulu (paling sering dipakai), baru **Rotasi Tim** dan **Primogem**.
4. Tes di lebar 375px (HP) dan 1280px (desktop) tiap selesai satu bagian.
5. Jalanin `npm test` di `backend/` sebelum commit — mostly buat mastiin nggak ada yang kesenggol di luar
   `public/index.html` (harusnya nggak ada, tapi aman dicek).
