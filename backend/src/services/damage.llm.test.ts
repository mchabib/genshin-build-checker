import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

// env dibaca saat modul di-load → set dulu, baru import dinamis (static import di-hoist)
process.env.LLM_API_KEY = "test-key";
process.env.LLM_BASE_URL = "http://llm.test";
const { LlmDamageOutputSchema, postValidate } = await import("./damage.llm");
const { chatJson, extractJson, LlmError } = await import("./llm.client");
const { loadBuffStore } = await import("./buffStore");
await loadBuffStore();

test("schema: cap nilai + default", () => {
  const ok = LlmDamageOutputSchema.safeParse({
    modifiers: [{ source: "x", atkPct: 20, resShred: { pyro: 40 } }],
    rotation: { label: "r", counts: { na1: 3 } },
  });
  assert.ok(ok.success);
  assert.deepEqual(ok.data.team, []);
  assert.equal(ok.data.modifiers[0].scope, "all");

  const bad = LlmDamageOutputSchema.safeParse({ modifiers: [{ source: "x", atkPct: 500 }] });
  assert.ok(!bad.success);
  const badReact = LlmDamageOutputSchema.safeParse({ reactionPerTalent: { ca: "explode" } });
  assert.ok(!badReact.success);
});

test("postValidate: catalogId nggak dikenal dibuang, auto di-skip, rotasi id invalid dibuang, resShred di-clamp", () => {
  const out = LlmDamageOutputSchema.parse({
    team: ["Xingqiu", " Yelan ", "Zhongli", "Bennett"],
    modifiers: [
      { catalogId: "hutao_a4", source: "A4", uptime: 0.6 },
      { catalogId: "hutao_e", source: "E" },
      { catalogId: "nope_id", source: "?" },
      { source: "Shred A", scope: "all", resShred: { pyro: 60 }, note: "a" },
      { source: "Shred B", scope: "all", resShred: { pyro: 60 }, note: "b" },
      { source: "Shred A", scope: "all", resShred: { pyro: 10 } },
    ],
    reactionPerTalent: { ca: "vaporize", burst: null },
    rotation: { label: "x", counts: { na1: 2, ca1: 3, "react:overloaded": 1, ghost: 5 } },
  });
  const r = postValidate(out, new Set(["na1", "ca1"]), new Set(["hutao_e"]), "HuTao");
  assert.deepEqual(r.team, ["Xingqiu", "Yelan", "Zhongli"]);
  assert.deepEqual(r.catalogIds, ["hutao_a4"]);
  assert.deepEqual(r.catalogUptime, { hutao_a4: 0.6 });
  assert.equal(r.customModifiers.length, 2);
  assert.equal(r.customModifiers[1].resShred?.pyro, 30); // 60 + 30 = 90 cap
  assert.deepEqual(r.rotation?.counts, { na1: 2, ca1: 3, "react:overloaded": 1 });
  assert.deepEqual(r.reactions, { ca: "vaporize", burst: null });
  assert.ok(r.warnings.some((w) => w.includes("nope_id")));
  assert.ok(r.warnings.some((w) => w.includes("ghost")));
  assert.ok(r.warnings.some((w) => w.includes("dobel")));
});

test("extractJson toleran ```json fence", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('bla {"a":2} bla'), { a: 2 });
});

test("chatJson: retry 1× kalau JSON pertama gagal validasi, lalu sukses", async () => {
  const calls: unknown[] = [];
  const replies = ['{"n": "bukan angka"}', '{"n": 7}'];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    const content = replies.shift();
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 10 }, model: "mock" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const r = await chatJson({ system: "s", user: "u", schema: z.object({ n: z.number() }) });
    assert.equal(r.data.n, 7);
    assert.equal(r.attempts, 2);
    assert.equal(calls.length, 2);
    // percobaan ke-2 bawa pesan koreksi
    const second = calls[1] as { messages: { role: string; content: string }[] };
    assert.equal(second.messages.length, 4);
    assert.match(second.messages[3].content, /nggak valid/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("chatJson: HTTP error → LlmError http", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("nope", { status: 401 })) as typeof fetch;
  try {
    await assert.rejects(
      chatJson({ system: "s", user: "u", schema: z.object({}) }),
      (e: unknown) => e instanceof LlmError && e.code === "http" && e.status === 401,
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});
