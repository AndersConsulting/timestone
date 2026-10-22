import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

const db = new PGlite({ extensions: { btree_gist } });
const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
before(async () => {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to authenticated, anon, service_role;
    insert into auth.users values ('${alice}'), ('${bob}');
  `);
  await db.exec(await readFile(new URL("../supabase/migrations/20261022125715_initial_attendance_and_absences.sql", import.meta.url), "utf8"));
  await db.query(`insert into public.users(fullname,email,auth_user_id) values ('Alice','alice@example.test',$1),('Bob','bob@example.test',$2)`, [alice, bob]);
});
after(() => db.close());

async function asUser<T>(fn: () => Promise<T>, role = "authenticated", id = alice): Promise<T> {
  await db.exec(`begin; set local role ${role};`);
  await db.query("select set_config('request.jwt.claim.sub', $1, true)", [id]);
  try { return await fn(); } finally { await db.exec("rollback"); }
}
const rows = async (sql: string) => (await db.query<Record<string, any>>(sql)).rows;

test("Standardpause 12:30–13:30 Berlin in Winter- und Sommerzeit", async () => {
  await asUser(async () => {
    for (const [day, offset, utc] of [["2026-01-12", "+01:00", 11], ["2026-07-12", "+02:00", 10]]) {
      const [entry] = await rows(`select * from public.log_attendance_without_break(1,'${day}T08:00:00${offset}','${day}T17:00:00${offset}')`);
      assert.equal(entry.start_break.getUTCHours(), utc);
      assert.equal(entry.start_break.getUTCMinutes(), 30);
      assert.equal(entry.end_break - entry.start_break, 3600000);
    }
  });
});
test("Eigene Pause und Schicht über Mitternacht", async () => {
  await asUser(async () => {
    const [entry] = await rows("select * from public.log_attendance_with_break(1,'2026-10-20T22:00:00+02:00','2026-10-21T06:00:00+02:00','2026-10-21T01:00:00+02:00','2026-10-21T01:30:00+02:00')");
    assert.equal(entry.end_break - entry.start_break, 1800000);
  });
});
test("Ungültige Pausen, umgekehrte Zeiten, Unendlichkeit und fehlende Werte werden abgelehnt", async () => {
  for (const sql of [
    "select public.log_attendance_without_break(1,'2026-10-20T14:00:00Z','2026-10-20T17:00:00Z')",
    "select public.log_attendance_without_break(1,'2026-10-20T08:00:00Z','2026-10-21T17:00:00Z')",
    "select public.log_attendance_with_break(1,'2026-10-20T08:00:00Z','2026-10-20T07:00:00Z','2026-10-20T09:00:00Z','2026-10-20T10:00:00Z')",
    "select public.log_attendance_with_break(1,'2026-10-20T08:00:00Z','infinity','2026-10-20T09:00:00Z','2026-10-20T10:00:00Z')",
    "select public.log_attendance_with_break(1,'2026-10-20T08:00:00Z','2026-10-20T17:00:00Z',null,null)",
  ]) await assert.rejects(asUser(() => db.exec(sql)));
});
test("Überlappende Anwesenheit wird abgelehnt", async () => {
  await assert.rejects(asUser(async () => {
    await db.exec("select public.log_attendance_without_break(1,'2026-10-20T08:00:00Z','2026-10-20T17:00:00Z')");
    await db.exec("select public.log_attendance_without_break(1,'2026-10-20T09:00:00Z','2026-10-20T18:00:00Z')");
  }), (error: any) => error.code === "23P01");
});
for (const kind of ["sickleave", "vacation"]) {
  const table = kind === "sickleave" ? "krankheit" : "urlaube";
  test(`${kind}: einzelne halbe Tage und inklusive Mehrtagesbereiche über Zeitumstellung`, async () => {
    await asUser(async () => {
      const single = await rows(`select * from public.log_${kind}_single_day(1,'2026-10-20',0.5)`);
      assert.equal(single.length, 1);
      assert.equal(Number(single[0].wholeday), 0.5);
      const multi = await rows(`select * from public.log_${kind}_multiday(1,'2026-10-24','2026-10-26')`);
      assert.equal(multi.length, 3);
      assert.ok(multi.every(r => Number(r.wholeday) === 1));
      if (kind === "vacation") assert.ok([...single, ...multi].every(r => r.is_approved === false));
    });
  });
  test(`${kind}: Konflikt rollt gesamten Mehrtagesaufruf zurück`, async () => {
    await asUser(async () => {
      await db.exec(`select public.log_${kind}_single_day(1,'2026-10-25')`);
      await db.exec("savepoint conflict");
      await assert.rejects(db.exec(`select public.log_${kind}_multiday(1,'2026-10-24','2026-10-26')`), (e: any) => e.code === "23505");
      await db.exec("rollback to savepoint conflict");
      assert.equal((await rows(`select * from public.${table}`)).length, 1);
    });
  });
  test(`${kind}: ungültige Werte und Bereiche werden auch ohne Edge Function abgelehnt`, async () => {
    for (const args of ["1,'2026-10-20','2026-10-19',1", "1,'2026-01-01','2028-01-01',1", "1,'2026-10-20','2026-10-21',0.51", "1,null,'2026-10-21',1", "1,'2026-10-20','2026-10-21',null"]) {
      await assert.rejects(asUser(() => db.exec(`select public.log_${kind}_multiday(${args})`)));
    }
  });
}
test("RLS: fremde Benutzer weder lesen noch bebuchen; anon ohne Zugriff", async () => {
  await asUser(async () => {
    assert.deepEqual((await rows("select id from public.users")).map(r => r.id), [1]);
  });
  for (const sql of [
    "select public.log_sickleave_single_day(2,'2026-10-20')",
    "select public.log_vacation_single_day(2,'2026-10-20')",
    "select public.log_attendance_without_break(2,'2026-10-20T08:00:00Z','2026-10-20T17:00:00Z')",
    "update public.users set auth_user_id = null where id = 1",
    "insert into public.urlaube(user_id,date,wholeday,is_approved) values (1,'2026-10-20',1,true)",
    "update public.urlaube set is_approved = true",
  ]) await assert.rejects(asUser(() => db.exec(sql)), (e: any) => e.code === "42501");
  await assert.rejects(asUser(() => db.exec("select * from public.users"), "anon"), (e: any) => e.code === "42501");
  await assert.rejects(asUser(() => db.exec("select public.log_sickleave_single_day(1,'2026-10-20')"), "anon"), (e: any) => e.code === "42501");
  await assert.rejects(asUser(() => db.exec("select public.log_sickleave_single_day(1,'2026-10-20')"), "authenticated", bob), (e: any) => e.code === "42501");
});
test("CardID/E-Mail eindeutig, Vorgesetzter muss existieren und darf nicht man selbst sein", async () => {
  for (const sql of [
    "insert into public.users(fullname,email) values ('Duplicate','ALICE@example.test')",
    "update public.users set vorgesetzter = 1 where id = 1",
    "update public.users set vorgesetzter = 999 where id = 1",
    "update public.users set card_id = (select card_id from public.users where id = 1) where id = 2",
  ]) await assert.rejects(asUser(() => db.exec(sql), "service_role"));
});
