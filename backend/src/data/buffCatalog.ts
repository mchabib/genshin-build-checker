import type { Modifier, TalentSlot } from "../services/damage.types";
import type { DamageCharacter } from "../services/damage.service";
import type { Element } from "../lib/stats";
import {
  getCharacterModule,
  resolveModifier,
  resolveSeconds,
  setBuffs,
  teamBuffs,
  weaponBuffs,
  type BuffMode,
  type ExprContext,
  type RawBuffEntry,
} from "../services/buffStore";
import type { TalentMeta } from "../lib/talentLabel";

/**
 * Katalog buff = adapter di atas `scrape-data/Buffs/*.json` (buffStore). Semua angka ada di JSON;
 * di sini cuma evaluasi ekspresi + filter kondisi. Dipakai dua jalur:
 *   - LLM: LLM nyebut `catalogId`, angka diambil dari sini.
 *   - Offline (tanpa LLM): `mode: always|assume` + `fromCharacter`/`assumeWith`/`resonance` diputuskan rule.
 */
export interface TeammateInfo {
  key: string;
  baseAtk: number | null;
  /** total ATK/HP/DEF dari Enka (buat buff yang scaling stat teammate: Ineffa ATK, Columbina HP) */
  atk: number | null;
  hp: number | null;
  def: number | null;
  em: number | null;
  con: number | null;
  constellation: number | null;
  talentLevels: Record<TalentSlot, number> | null;
}

export interface TeamCtx {
  keys: string[];
  /** elemen unik di tim termasuk karakter sendiri (lowercase) */
  elements: string[];
  /** jumlah teammate (0-3) */
  count: number;
  /** teammate yang elemennya sama dengan karakter */
  sameElementCount: number;
}

export interface CatalogCtx {
  char: DamageCharacter;
  key: string;
  constellation: number;
  er: number;
  team: TeamCtx;
  /** nama set 4pc terpasang (ter-normalisasi) */
  sets4: string[];
  talentParam: (slot: TalentSlot, param: string) => number | undefined;
  teammate: (key: string) => TeammateInfo | null;
  teammateParam: (key: string, slot: TalentSlot, param: string) => number | undefined;
  /** nilai efek senjata ke-i di refinement user */
  weaponValue: (i: number) => number;
  /** durasi/CD talent (label "Duration"/"CD") karakter sendiri / teammate */
  talentMeta: (slot: TalentSlot) => TalentMeta;
  teammateMeta: (key: string, slot: TalentSlot) => TalentMeta;
}

export interface BuffTiming {
  duration?: number;
  cooldown?: number;
  /** "entry" = ditulis di JSON, "talent" = otomatis dari label Duration/CD talent teammate */
  source: "entry" | "talent";
}

export interface CatalogEntry {
  id: string;
  kind: "self" | "team";
  mode: BuffMode;
  description: string;
  /** nama sumber dari mod (buat pesan), kalau ada dan bukan ekspresi */
  source?: string;
  forCharacter?: string;
  forSet?: string;
  forWeapon?: string;
  fromCharacter?: string;
  assumeWith?: string[];
  resonance?: Element;
  onlyElements?: Element[];
  requireCon?: number;
  requireTeamElement?: Element;
  requiresAction?: "skill" | "burst";
  /** null = kondisi nggak terpenuhi */
  build: (ctx: CatalogCtx) => Modifier | null;
  /** durasi/CD buff (buat uptime nyata); null = nggak diketahui */
  timing: (ctx: CatalogCtx) => BuffTiming | null;
}

function exprCtx(ctx: CatalogCtx): ExprContext {
  return {
    char: ctx.char,
    con: ctx.constellation,
    er: ctx.er,
    p: (slot: string, param: string) => ctx.talentParam(slot as TalentSlot, param),
    tp: (key: string, slot: string, param: string) => ctx.teammateParam(key, slot as TalentSlot, param),
    tm: (key: string) => ctx.teammate(key),
    team: ctx.team,
    wv: ctx.weaponValue,
    meta: (slot: string) => ctx.talentMeta(slot as TalentSlot),
    tmeta: (key: string, slot: string) => ctx.teammateMeta(key, slot as TalentSlot),
  };
}

function makeTiming(e: RawBuffEntry & { fromCharacter?: string; requiresAction?: "skill" | "burst" }) {
  return (ctx: CatalogCtx): BuffTiming | null => {
    try {
      const duration = resolveSeconds(e.duration, exprCtx(ctx));
      const cooldown = resolveSeconds(e.cooldown, exprCtx(ctx));
      if (duration != null || cooldown != null) return { duration, cooldown, source: "entry" };
    } catch (err) {
      console.warn(`[buffCatalog] durasi ${e.id} gagal: ${(err as Error).message}`);
      return null;
    }
    // team buff yang nempel ke E/Q teammate: durasi dari label talent-nya (Bennett Q 12s / CD 15s)
    if (e.fromCharacter && e.requiresAction) {
      const m = ctx.teammateMeta(e.fromCharacter, e.requiresAction);
      if (m.duration != null || m.cd != null) return { duration: m.duration, cooldown: m.cd, source: "talent" };
    }
    return null;
  };
}

/** Kondisi umum yang berlaku buat semua entry (self/team/set/senjata). */
function conditionsOk(e: RawBuffEntry & { fromCharacter?: string }, ctx: CatalogCtx, kind: "self" | "team"): boolean {
  if (e.onlyElements && !e.onlyElements.includes(ctx.char.element)) return false;
  if (e.requireTeamElement && !ctx.team.elements.includes(e.requireTeamElement)) return false;
  if (e.requireSet && !ctx.sets4.includes(e.requireSet.toLowerCase().replace(/[^a-z0-9]/g, ""))) return false;
  if (e.requireCon != null) {
    if (kind === "self") {
      if (ctx.constellation < e.requireCon) return false;
    } else if (e.fromCharacter) {
      const c = ctx.teammate(e.fromCharacter)?.constellation;
      if (c != null && c < e.requireCon) return false; // nggak diketahui → dianggap OK
    }
  }
  return true;
}

function makeBuild(e: RawBuffEntry & { fromCharacter?: string }, kind: "self" | "team") {
  return (ctx: CatalogCtx): Modifier | null => {
    if (!conditionsOk(e, ctx, kind)) return null;
    try {
      return resolveModifier(e.id, e.mod, exprCtx(ctx), ctx.char.element);
    } catch (err) {
      console.warn(`[buffCatalog] ekspresi ${e.id} gagal: ${(err as Error).message}`);
      return null;
    }
  };
}

/** Semua entry katalog (butuh loadBuffStore() sudah jalan). */
export function catalogEntries(): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const e of teamBuffs())
    out.push({
      ...e,
      kind: "team",
      // team: default "always" = otomatis kalau fromCharacter/assumeWith/resonance terpenuhi; "manual" eksplisit = cuma via --catalog
      mode: e.mode ?? "always",
      source: typeof e.mod.source === "string" && !e.mod.source.startsWith("=") ? e.mod.source : undefined,
      build: makeBuild(e, "team"),
      timing: makeTiming(e),
    });
  for (const e of setBuffs())
    out.push({ ...e, kind: "self", mode: e.mode ?? "manual", forSet: e.set, build: makeBuild(e, "self"), timing: makeTiming(e) });
  for (const e of weaponBuffs())
    out.push({ ...e, kind: "self", mode: e.mode ?? "manual", forWeapon: e.weapon, build: makeBuild(e, "self"), timing: makeTiming(e) });
  return out;
}

/** Entry self dari modul karakter tertentu. */
export function characterEntries(key: string): CatalogEntry[] {
  const m = getCharacterModule(key);
  if (!m) return [];
  return m.self.map((e) => ({ ...e, kind: "self", mode: e.mode ?? "manual", forCharacter: key, build: makeBuild(e, "self"), timing: makeTiming(e) }));
}

export function allEntriesFor(key: string): CatalogEntry[] {
  return [...characterEntries(key), ...catalogEntries()];
}

export function catalogById(id: string, key?: string): CatalogEntry | undefined {
  return (key ? allEntriesFor(key) : catalogEntries()).find((c) => c.id === id);
}
