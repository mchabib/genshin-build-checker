# Genshin Build Checker

Personal web project — artifact/substat checker with damage rotation calculator for Genshin Impact, built in 3 phases.

## Project Phases

### Fase 1 — Artifact Substat Checker (current phase)
Input via UID (auto-fetch) atau manual input, dibandingkan ke benchmark substat.

**Data source: hybrid**
- **Default path**: User masukin UID Genshin → auto-fetch karakter dari Enka.Network API (`https://enka.network/api/uid/{UID}`) → user pilih karakter yang mau dicek dari hasil showcase.
- **Fallback path**: Manual input tetep disediakan untuk karakter yang tidak ter-showcase, atau saat API down/rate-limited.

**Limitasi Enka API yang perlu di-handle di UI/UX:**
- Hanya menampilkan karakter yang di-*showcase* user (Character Showcase di in-game profile, max 8 slot). Karakter yang tidak di-pin tidak akan muncul — perlu pesan/instruksi ke user untuk pin karakter dulu.
- Rate limit per UID, cooldown ±60 detik antar fetch untuk UID yang sama. Perlu caching/debounce di backend.
- Data adalah snapshot terakhir kali profile di-refresh oleh server HoYo, bukan real-time.
- Jika setting privasi "Show Character Details" user dimatikan, response API bisa kosong/limited — perlu fallback message.
- UID punya prefix region (1-5 CN, 6 US, 7 EU, 8/9 Asia/TW-HK-MO) — endpoint utama biasanya auto-detect, tapi perlu diperhatikan kalau ada logic tambahan berbasis region.

**Scope fase 1:**
- Input UID → fetch → pilih karakter → tampilkan artifact set + substat
- Compare substat ke benchmark (per karakter/build)
- Manual input form sebagai fallback

### Fase 2 — Damage Calculator Sederhana
Single target, tanpa reaction. Dibangun di atas data artifact/substat dari fase 1.

### Fase 3 — Reaction + Buff System + Rotation Builder
Full damage rotation dengan elemental reaction dan buff stacking.

---

## Rencana awal

Mulai dari **Fase 1** dulu. Fokus ke:
1. Skema database untuk menyimpan data karakter, artifact, substat, dan benchmark.
2. Integrasi Enka.Network API dengan fallback manual input.
3. Logic compare substat aktual vs benchmark.

Jangan implementasikan fase 2 dan 3 dulu — itu untuk chat/task terpisah setelah fase 1 selesai.
