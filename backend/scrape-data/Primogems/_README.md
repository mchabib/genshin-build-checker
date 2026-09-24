# scrape-data/Primogems — kalkulator income primogem

Data tangan, **bukan hasil scrape**. Dibaca `src/services/primogem.service.ts`; scraper nggak pernah
nulis ke folder ini. Ubah angkanya kalau HoYo ganti reward — kode nggak perlu disentuh.

## `_sources.json`

| Bagian | Arti |
|---|---|
| `perWish` | primogem per 1 wish (160) |
| `daily.commission.perDay` | daily commission (60/hari: 4 komisi @10 + 20 bonus Katheryne) |
| `welkin` | `perDay` 90 + `onPurchase` 300 tiap `purchaseDays` 30 (total 3.000 per bulan) |
| `battlePass` | per `cycleDays` (ikut siklus patch). Tier `none` / `free` / `paid` |
| `cycles.<nama>` | konten yang reset berkala. `resetDays` = tanggal reset tiap bulan ([1, 16] = dua kali sebulan) |
| `cycles.abyss` | skala dari bintang: `maxPrimogems × bintang / maxUnits` |
| `cycles.theater`, `cycles.stygian` | pilih `tiers.<key>` |
| `patch` | `cycleDays` 42 + `anchor` (versi & tanggal mulai) → dipakai buat nebak jadwal patch berikutnya |
| `patch.perPatch` | income sekali per patch: kode livestream, kompensasi maintenance |

## Cara hitung

- **Harian** (`daily`, `welkin`): dikali jumlah hari di rentang.
- **Siklus** (`cycles`): dihitung berapa kali tanggal reset kelewat di rentang, dikali reward tier/bintang.
  Siklus yang **sedang berjalan** (belum reset lagi) nggak dihitung — anggap rewardnya udah kamu ambil.
- **Per patch** (`patch.perPatch`, `battlePass`): di-*prorate* dari berapa hari rentangnya menutupi patch.
  Rentang 21 hari di tengah patch 42 hari = 0,5 patch. Jadi nggak ada lonjakan aneh di batas patch.

Hasil akhir: `wish = floor(total primogem / 160) + total fate`.

## Kalau jadwal patch berubah

Cukup update `patch.anchor` ke versi + tanggal patch terbaru. Versi berikutnya ditebak dari `cycleDays`
(7.1 → 7.2 → … → 7.8 → 8.0), cuma buat label.

## Asumsi

- Primo yang **hari ini sudah bisa diambil dianggap sudah diambil** — yang dihitung cuma yang datang setelahnya.
- Battle Pass naik `levelsPerDay` level/hari (default 1.5) dan reset tiap patch. Patch pertama cuma menghitung
  sisa level dari `bpLevel` yang kamu isi; patch berikutnya dianggap dari 0.
- Abyss & Theater & Stygian dihitung **per reset yang kelewat**, bukan yang sedang berjalan.
- Toko Stardust: 5 Intertwined Fate tiap reset bulanan (cuma fate, Acquaint diabaikan).
- **Income dari EVENT sengaja tidak dihitung** — jumlahnya beda-beda tiap patch dan tidak bisa ditebak.
  Pakai kolom "Quest/eksplorasi (manual)" di UI (atau `--extra` di CLI) kalau mau menambahkan sendiri.
