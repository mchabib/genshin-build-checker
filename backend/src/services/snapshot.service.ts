import { promises as fs } from "node:fs";
import path from "node:path";
import { fetchEnkaProfile } from "./enka.service";
import { mapShowcase } from "./enka.mapper";
import { runDamage } from "./damage.run";
import { runTeamRotation } from "./rotation.run";
import { loadCharacterStore } from "./characterStore";
import { loadGuideStore } from "./guideStore";
import { loadGameDataStore } from "./gameDataStore";
import { loadBuffStore } from "./buffStore";

/**
 * Snapshot regresi damage offline. Sumber = fixture Enka di `src/fixtures/enka/uid-<uid>.json`
 * (env `ENKA_FIXTURE_DIR`), hasil = `src/fixtures/snapshots/<uid>.json` berisi total rotasi + avg per hit
 * tiap karakter showcase (+ rotasi tim kalau ada notasinya). Test bandingin dengan toleransi kecil supaya
 * perubahan kalkulasi/data yang ngubah angka KETAHUAN — bukan supaya angkanya benar (itu validasi manual).
 */

export const FIXTURE_DIR = path.resolve("src/fixtures/enka");
export const SNAPSHOT_DIR = path.resolve("src/fixtures/snapshots");

/** UID yang di-snapshot + notasi rotasi tim (opsional) */
export const SNAPSHOT_TARGETS: { uid: string; teamRotation?: string }[] = [
  { uid: "100000001" },
  { uid: "100000002", teamRotation: "Yae 3[E] > Odette 2[E] > Qiqi E Q > Sandrone 3[C E] Q" },
];

export interface CharacterSnapshot {
  rotation: string | null;
  total: number;
  hits: Record<string, number>;
  modifiers: string[];
}

export interface UidSnapshot {
  uid: string;
  characters: Record<string, CharacterSnapshot>;
  teamRotation?: { notation: string; total: number; perCharacter: Record<string, number> };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function useFixtures(): void {
  process.env.ENKA_FIXTURE_DIR = FIXTURE_DIR;
}

export async function collectSnapshot(target: { uid: string; teamRotation?: string }): Promise<UidSnapshot> {
  useFixtures();
  await Promise.all([loadCharacterStore(), loadGuideStore(), loadGameDataStore(), loadBuffStore()]);
  const profile = await fetchEnkaProfile(target.uid);
  const showcase = mapShowcase(profile.data).filter((c) => c.key && c.supported);
  const characters: Record<string, CharacterSnapshot> = {};
  for (const sc of showcase) {
    const rep = await runDamage(target.uid, sc.key!, { llm: false });
    const hits: Record<string, number> = {};
    for (const h of rep.buffed.hits) hits[h.id] = r1(h.avg);
    characters[sc.key!] = {
      rotation: rep.rotation?.label ?? null,
      total: r1(rep.rotation?.total ?? 0),
      hits,
      modifiers: rep.modifiers.map((m) => m.id ?? m.source).sort(),
    };
  }
  const snap: UidSnapshot = { uid: target.uid, characters };
  if (target.teamRotation) {
    const t = await runTeamRotation(target.uid, target.teamRotation);
    const perCharacter: Record<string, number> = {};
    for (const c of t.characters) perCharacter[c.key] = r1(c.subtotal);
    snap.teamRotation = { notation: target.teamRotation, total: r1(t.total), perCharacter };
  }
  return snap;
}

export function snapshotFile(uid: string): string {
  return path.join(SNAPSHOT_DIR, `${uid}.json`);
}

export async function readSnapshot(uid: string): Promise<UidSnapshot | null> {
  try {
    return JSON.parse(await fs.readFile(snapshotFile(uid), "utf8")) as UidSnapshot;
  } catch {
    return null;
  }
}

export async function writeSnapshot(snap: UidSnapshot): Promise<string> {
  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
  const file = snapshotFile(snap.uid);
  await fs.writeFile(file, JSON.stringify(snap, null, 2) + "\n", "utf8");
  return file;
}

/** Bandingin dua snapshot; balikin daftar perbedaan (kosong = sama dalam toleransi). */
export function diffSnapshot(expected: UidSnapshot, actual: UidSnapshot, tolerance = 0.005): string[] {
  const out: string[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b), 1) * tolerance;
  const fmt = (a: number, b: number) => `${a} → ${b} (${b === a ? "0" : (((b - a) / (a || 1)) * 100).toFixed(2)}%)`;

  for (const key of Object.keys(expected.characters)) {
    const e = expected.characters[key];
    const a = actual.characters[key];
    if (!a) {
      out.push(`${key}: hilang dari showcase/hasil`);
      continue;
    }
    if (e.rotation !== a.rotation) out.push(`${key}: label rotasi "${e.rotation}" → "${a.rotation}"`);
    if (!near(e.total, a.total)) out.push(`${key}: total rotasi ${fmt(e.total, a.total)}`);
    for (const id of Object.keys(e.hits)) {
      if (a.hits[id] == null) out.push(`${key}.${id}: hit hilang`);
      else if (!near(e.hits[id], a.hits[id])) out.push(`${key}.${id}: ${fmt(e.hits[id], a.hits[id])}`);
    }
    for (const id of Object.keys(a.hits)) if (e.hits[id] == null) out.push(`${key}.${id}: hit baru (belum di snapshot)`);
    const em = e.modifiers.join(","), am = a.modifiers.join(",");
    if (em !== am) out.push(`${key}: daftar modifier berubah: [${em}] → [${am}]`);
  }
  for (const key of Object.keys(actual.characters)) if (!expected.characters[key]) out.push(`${key}: karakter baru (belum di snapshot)`);

  if (expected.teamRotation || actual.teamRotation) {
    const e = expected.teamRotation, a = actual.teamRotation;
    if (!e || !a) out.push(`rotasi tim: ${e ? "hilang" : "baru"}`);
    else {
      if (e.notation !== a.notation) out.push(`rotasi tim: notasi berubah`);
      if (!near(e.total, a.total)) out.push(`rotasi tim: total ${fmt(e.total, a.total)}`);
      for (const k of Object.keys(e.perCharacter))
        if (a.perCharacter[k] == null || !near(e.perCharacter[k], a.perCharacter[k]))
          out.push(`rotasi tim.${k}: ${fmt(e.perCharacter[k], a.perCharacter[k] ?? 0)}`);
    }
  }
  return out;
}
