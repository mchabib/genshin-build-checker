import type { HitDef, HitKind, Scaling, ScalingStat, TalentSlot } from "../services/damage.types";

/**
 * Koreksi hasil parse label genshin-db per karakter. Dipakai kalau label-nya ambigu
 * (mis. "Breakthrough Barb DMG" Yelan = Charged Attack tapi labelnya nggak bilang) ATAU dump
 * genshin-db belum punya kit terbaru (Yae Miko update 6.7 "Witch's Revelation").
 *   drop  : regex label yang dibuang (bukan hit relevan)
 *   kind  : label regex -> HitKind
 *   add   : hit tambahan yang nggak ada di dump. scaling: `values` (15 level), `const` (persen pecahan tetap,
 *           mis. 0.8 = 80% ATK), atau `copyOf` (salin scaling pertama hit lain, buat "hit X + 80% ATK").
 */
export interface AddedHit {
  id: string;
  label: string;
  kind: HitKind;
  slot: TalentSlot;
  scalings: ({ stat: ScalingStat; values: number[] } | { stat: ScalingStat; const: number } | { copyOf: string })[];
  hitCount?: number;
  stellar?: "conduct" | "swirl";
  lunar?: "charged";
}
export interface TalentOverride {
  drop?: RegExp[];
  kind?: { match: RegExp; kind: HitKind }[];
  add?: AddedHit[];
}

export const TALENT_OVERRIDES: Record<string, TalentOverride> = {
  Yelan: { kind: [{ match: /Breakthrough Barb/i, kind: "ca" }] },
  Noelle: { kind: [{ match: /Charged Attack/i, kind: "ca" }] },
  Furina: { drop: [/Spiritbreath Thorn\/Surging Blade/i] },
  Neuvillette: { drop: [/Spiritbreath Thorn/i] },
  Clorinde: { drop: [/Surging Blade/i] },
  // A1 Overclocking Circuit: tiap Discharge Birgitta saat ada thundercloud → hit 65% ATK Lunar-Charged DMG (di dump cuma teks passive)
  Ineffa: {
    add: [{ id: "skill3", label: "Birgitta Overclocking Lunar-Charged DMG (A1)", kind: "skill", slot: "skill", scalings: [{ stat: "atk", const: 0.65 }], lunar: "charged" }],
  },
  // Kit 6.7 (Witch's Revelation) — sumber: guide KQM Yae (dump genshin-db masih v2.5).
  YaeMiko: {
    add: [
      // A1: E saat 3 Sesshou Sakura sudah ada → hit tambahan 40% ATK (50% ATK Stellar-Conduct di Polestar Field)
      { id: "skill5", label: "Additional Lightning Strike (3 Sakura) DMG", kind: "skill", slot: "skill", scalings: [{ stat: "atk", const: 0.4 }] },
      { id: "skill6", label: "Additional Lightning Strike (3 Sakura) Stellar-Conduct DMG", kind: "skill", slot: "skill", scalings: [{ stat: "atk", const: 0.5 }], stellar: "conduct" },
      // Edict of Cleansing: tembakan berikutnya setelah Superconduct/Stellar-Conduct dipicu = Lv3 + 80% ATK (ICD 2.5s)
      { id: "skill7", label: "Sesshou Sakura Enhanced (Lv3 + 80% ATK) DMG", kind: "skill", slot: "skill", scalings: [{ copyOf: "skill3" }, { stat: "atk", const: 0.8 }] },
      // …dan di Radiance: Stellar-Conduct, tembakan enhanced itu nambah 1 hit 200% ATK Stellar-Conduct DMG
      { id: "skill8", label: "Edict of Cleansing Stellar-Conduct DMG", kind: "skill", slot: "skill", scalings: [{ stat: "atk", const: 2.0 }], stellar: "conduct" },
    ],
  },
};

export function applyTalentOverrides(key: string | null, hits: HitDef[]): HitDef[] {
  const ov = key ? TALENT_OVERRIDES[key] : undefined;
  if (!ov) return hits;
  const kept = hits.filter((h) => !ov.drop?.some((re) => re.test(h.label)));
  const out = kept.map((h) => {
    const k = ov.kind?.find((r) => r.match.test(h.label));
    if (!k || k.kind === h.kind) return h;
    // id ikut kind baru biar nggak misleading ("na5" padahal CA)
    const n = kept.filter((x) => x.kind === k.kind && x !== h).length + 1;
    return { ...h, kind: k.kind, id: `${k.kind}${n}` };
  });
  for (const a of ov.add ?? []) {
    if (out.some((h) => h.id === a.id)) continue; // dump sudah punya → jangan dobel
    const scalings: Scaling[] = [];
    for (const s of a.scalings) {
      if ("copyOf" in s) {
        const src = out.find((h) => h.id === s.copyOf);
        if (src) scalings.push(...src.scalings);
      } else if ("const" in s) scalings.push({ stat: s.stat, values: Array(15).fill(s.const) });
      else scalings.push(s);
    }
    if (scalings.length)
      out.push({ id: a.id, label: a.label, kind: a.kind, slot: a.slot, scalings, hitCount: a.hitCount ?? 1, ...(a.stellar ? { stellar: a.stellar } : {}), ...(a.lunar ? { lunar: a.lunar } : {}) });
  }
  return out;
}
