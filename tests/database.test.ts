import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
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
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to authenticated, anon, service_role;
    insert into auth.users values ('${alice}'), ('${bob}');
  `);
  const migrations = new URL("../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(migrations)).filter(file => file.endsWith(".sql")).sort()) {
    // PGlite has no background workers / pg_cron. Verify scheduling on Supabase.
    if (file.endsWith("_schedule_midnight_close.sql")) continue;
    await db.exec(await readFile(new URL(file, migrations), "utf8"));
  }
  await db.query(`insert into public.users(fullname,email,auth_user_id) values ('Alice','alice@example.test',$1),('Bob','bob@example.test',$2)`, [alice, bob]);
});
after(() => db.close());

async function asUser<T>(fn: () => Promise<T>, role = "authenticated", id = alice): Promise<T> {
  await db.exec(`begin; set local role ${role};`);
  await db.query("select set_config('request.jwt.claim.sub', $1, true)", [id]);
  try { return await fn(); } finally { await db.exec("rollback"); }
}
const rows = async (sql: string) => (await db.query<Record<string, any>>(sql)).rows;

test("Tagesabschluss: exakt Berliner Mitternacht, Nachholen, Pause und wiederholter Lauf", async () => {
  await db.exec("begin");
  try {
    await db.exec(`insert into public.anwesenheit(user_id,start_at,is_clock_entry) values
      (1,'2026-07-20T08:00:00+02:00',true), (2,'2026-07-21T00:00:00+02:00',true)`);
    assert.equal((await rows("select timestone_private.close_open_attendance('2026-07-20T23:59:59+02:00') as count"))[0].count, 0);
    assert.equal((await rows("select timestone_private.close_open_attendance('2026-07-21T00:00:00+02:00') as count"))[0].count, 1);
    const [entry, current] = await rows("select * from public.anwesenheit order by user_id");
    assert.equal(entry.end_at.toISOString(), "2026-07-20T22:00:00.000Z");
    assert.equal(entry.auto_closed, true);
    assert.equal(entry.start_break.toISOString(), "2026-07-20T10:30:00.000Z");
    assert.equal(current.end_at, null);
    assert.equal((await rows("select timestone_private.close_open_attendance('2026-07-21T00:01:00+02:00') as count"))[0].count, 0);
    assert.equal((await rows("select timestone_private.close_open_attendance('2026-07-24T09:00:00+02:00') as count"))[0].count, 1);
    const updated = await rows("select * from public.anwesenheit order by user_id");
    assert.deepEqual(updated[0], entry);
    assert.equal(updated[1].end_at.toISOString(), "2026-07-21T22:00:00.000Z");
  } finally { await db.exec("rollback"); }
});
test("Tagesabschluss: Sommer-/Winterzeit und später Start ohne Mittagspause", async () => {
  for (const [start, next, gross, pause] of [
    ["2026-03-29T00:00:00+01:00", "2026-03-30T00:00:00+02:00", 23, 1],
    ["2026-10-25T00:00:00+02:00", "2026-10-26T00:00:00+01:00", 25, 1],
    ["2026-07-20T13:00:00+02:00", "2026-07-21T00:00:00+02:00", 11, 0],
  ] as const) {
    await db.exec("begin");
    try {
      await db.query("insert into public.anwesenheit(user_id,start_at,is_clock_entry) values(1,$1,true)", [start]);
      await db.query("select timestone_private.close_open_attendance($1)", [next]);
      const [summary] = await rows("select * from public.attendance_daily_summary");
      assert.equal(Number(summary.gross_seconds), gross * 3600);
      assert.equal(Number(summary.break_seconds), pause * 3600);
      assert.equal(Number(summary.net_hours), gross - pause);
    } finally { await db.exec("rollback"); }
  }
});
test("Tagesabschluss: kein Aufruf oder Manipulieren des Markers durch normale Benutzer", async () => {
  for (const role of ["authenticated", "anon", "service_role"]) {
    await assert.rejects(asUser(() => db.exec("select timestone_private.close_open_attendance()"), role), (e: any) => e.code === "42501");
  }
  await assert.rejects(asUser(() => db.exec("update public.anwesenheit set auto_closed = true")), (e: any) => e.code === "42501");
});
test("Direkter Clock-out nach Tagesende wird auf Mitternacht begrenzt", async () => {
  await asUser(async () => {
    await db.exec("insert into public.anwesenheit(user_id,start_at,is_clock_entry) values (1,'2026-07-20T22:00:00+02:00',true)");
    await db.exec("update public.anwesenheit set end_at='2026-07-21T07:00:00+02:00'");
    const [entry] = await rows("select * from public.anwesenheit");
    assert.equal(entry.end_at.toISOString(), "2026-07-20T22:00:00.000Z");
    assert.equal(entry.auto_closed, true);
    assert.equal(entry.start_break, null);
  });
});

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

test("Stempeln: erster Aufruf öffnet, zweiter schließt denselben Datensatz ohne Pause", async () => {
  await asUser(async () => {
    const [first] = await rows("select public.log_attendance_clockin(1) as result");
    assert.equal(first.result.action, "clock_in");
    assert.equal(first.result.attendance.end_at, null);
    assert.equal(first.result.attendance.start_break, null);
    assert.equal(first.result.attendance.end_break, null);
    const [second] = await rows("select public.log_attendance_clockin(1) as result");
    assert.equal(second.result.action, "clock_out");
    assert.equal(second.result.attendance.id, first.result.attendance.id);
    assert.ok(Date.parse(second.result.attendance.end_at) >= Date.parse(first.result.attendance.start_at));
    assert.equal(second.result.attendance.start_break, null);
    assert.equal(second.result.attendance.end_break, null);
    assert.equal((await rows("select * from public.anwesenheit")).length, 1);
    await db.exec("savepoint closed");
    await assert.rejects(db.exec("select public.log_attendance_clockin(1)"), (e: any) => e.code === "PT409");
    await db.exec("rollback to savepoint closed");
    const [entry] = await rows("select * from public.anwesenheit");
    assert.equal(entry.end_at.toISOString(), new Date(second.result.attendance.end_at).toISOString());
  });
});

test("Stempeln: fremde oder nicht vorhandene Benutzer sowie anon werden abgewiesen", async () => {
  for (const user of [2, 999]) {
    await assert.rejects(asUser(() => db.exec(`select public.log_attendance_clockin(${user})`)), (e: any) => e.code === "42501");
  }
  await assert.rejects(asUser(() => db.exec("select public.log_attendance_clockin(1)"), "anon"), (e: any) => e.code === "42501");
});

test("Stempeln: vor dem Cron-Lauf wird gestern um Mitternacht geschlossen und heute neu geöffnet", async () => {
  await asUser(async () => {
    await db.exec(`insert into public.anwesenheit(user_id,start_at,is_clock_entry)
      values (1, (((clock_timestamp() at time zone 'Europe/Berlin')::date - 1) + time '08:00') at time zone 'Europe/Berlin', true)`);
    const [result] = await rows("select public.log_attendance_clockin(1) as result");
    assert.equal(result.result.action, "clock_in");
    const entries = await rows("select *, (end_at at time zone 'Europe/Berlin')::time as local_end from public.anwesenheit order by start_at");
    assert.equal(entries.length, 2);
    assert.equal(entries[0].auto_closed, true);
    assert.equal(entries[0].local_end, "00:00:00");
    assert.equal(entries[1].end_at, null);
    assert.equal(entries[1].auto_closed, false);
  });
});

test("Stempeln: bereits vollständig gebuchter Tag bleibt unverändert", async () => {
  await asUser(async () => {
    await db.exec(`select public.log_attendance_without_break(1,
      ((clock_timestamp() at time zone 'Europe/Berlin')::date + time '08:00') at time zone 'Europe/Berlin',
      ((clock_timestamp() at time zone 'Europe/Berlin')::date + time '17:00') at time zone 'Europe/Berlin')`);
    const before = await rows("select * from public.anwesenheit");
    await db.exec("savepoint complete");
    await assert.rejects(db.exec("select public.log_attendance_clockin(1)"), (e: any) => e.code === "PT409");
    await db.exec("rollback to savepoint complete");
    assert.deepEqual(await rows("select * from public.anwesenheit"), before);
  });
});

test("Update-Rechte erlauben nur das Schließen eigener offener Stempelbuchungen", async () => {
  await asUser(async () => {
    await db.exec("select public.log_attendance_clockin(1)");
    assert.equal((await rows("update public.anwesenheit set end_at = clock_timestamp() returning id")).length, 1);
    assert.equal((await rows("update public.anwesenheit set end_at = clock_timestamp() returning id")).length, 0);
  });
  for (const assignment of ["user_id = 2", "start_at = clock_timestamp()", "is_clock_entry = false"]) {
    await assert.rejects(asUser(() => db.exec(`update public.anwesenheit set ${assignment}`)), (e: any) => e.code === "42501");
  }
});

test("Offene Stempelbuchungen haben keine Pause; vollständige Buchungen benötigen weiterhin Endzeit", async () => {
  await asUser(async () => {
    await db.exec(`insert into public.anwesenheit(user_id,start_at,start_break,end_break,is_clock_entry)
      values (1,'2026-10-20T08:00:00Z','2026-10-20T12:00:00Z','2026-10-20T13:00:00Z',true)`);
    const [entry] = await rows("select * from public.anwesenheit");
    assert.equal(entry.start_break, null);
    assert.equal(entry.end_break, null);
  });
  await assert.rejects(asUser(() => db.exec("select public.log_attendance_with_break(1,'2026-10-20T08:00:00Z',null,'2026-10-20T12:00:00Z','2026-10-20T13:00:00Z')")), (e: any) => e.code === "23514");
});

test("Nach geschlossener Vortagsbuchung beginnt heute ein neuer Clock-in", async () => {
  await asUser(async () => {
    await db.exec(`insert into public.anwesenheit(user_id,start_at,end_at,is_clock_entry)
      values (1,
        (((clock_timestamp() at time zone 'Europe/Berlin')::date - 1) + time '08:00') at time zone 'Europe/Berlin',
        (((clock_timestamp() at time zone 'Europe/Berlin')::date - 1) + time '17:00') at time zone 'Europe/Berlin', true)`);
    const [entry] = await rows("select public.log_attendance_clockin(1) as result");
    assert.equal(entry.result.action, "clock_in");
    assert.equal((await rows("select * from public.anwesenheit")).length, 2);
  });
});

test("Ein Stempelpaar je Berliner Tag, auch wenn die UTC-Daten verschieden sind", async () => {
  await assert.rejects(asUser(async () => {
    await db.exec(`insert into public.anwesenheit(user_id,start_at,end_at,is_clock_entry)
      values (1,'2026-10-20T22:30:00Z','2026-10-20T23:00:00Z',true)`);
    await db.exec(`insert into public.anwesenheit(user_id,start_at,end_at,is_clock_entry)
      values (1,'2026-10-21T08:00:00Z','2026-10-21T09:00:00Z',true)`);
  }), (e: any) => e.code === "23505");
});

test("Direktes Update kann keine fremde offene Buchung schließen", async () => {
  await asUser(async () => {
    await db.exec(`insert into public.anwesenheit(user_id,start_at,is_clock_entry)
      values (2,clock_timestamp() - interval '1 hour',true)`);
    await db.exec("set local role authenticated");
    assert.equal((await rows("update public.anwesenheit set end_at = clock_timestamp() where user_id = 2 returning id")).length, 0);
  }, "service_role");
});

test("Automatische Pause: strikte 7h-Grenze, 12:30-Grenze, vollständige Pause und Sommer-/Winterzeit", async () => {
  for (const [start, end, expected] of [
    ["2026-07-20T07:00:00+02:00", "2026-07-20T14:00:00+02:00", null],
    ["2026-07-20T07:00:00+02:00", "2026-07-20T14:00:01+02:00", "2026-07-20T10:30:00.000Z"],
    ["2026-07-20T12:30:00+02:00", "2026-07-20T20:00:00+02:00", "2026-07-20T10:30:00.000Z"],
    ["2026-07-20T12:30:01+02:00", "2026-07-20T21:00:00+02:00", null],
    ["2026-07-20T05:00:00+02:00", "2026-07-20T12:31:00+02:00", null],
    ["2026-01-20T08:00:00+01:00", "2026-01-20T17:00:00+01:00", "2026-01-20T11:30:00.000Z"],
  ]) {
    await asUser(async () => {
      await db.query("insert into public.anwesenheit(user_id,start_at,end_at,is_clock_entry) values (1,$1,$2,true)", [start, end]);
      const [entry] = await rows("select * from public.anwesenheit");
      assert.equal(entry.start_break?.toISOString() ?? null, expected);
      if (expected) assert.equal(entry.end_break - entry.start_break, 3600000);
      else assert.equal(entry.end_break, null);
    });
  }
});

test("Pause wird beim Schließen einer offenen Buchung automatisch berechnet", async () => {
  await asUser(async () => {
    await db.exec("insert into public.anwesenheit(user_id,start_at,is_clock_entry) values(1,'2026-07-20T08:00:00+02:00',true)");
    await db.exec("update public.anwesenheit set end_at = '2026-07-20T17:00:00+02:00'");
    const [entry] = await rows("select * from public.anwesenheit");
    assert.equal(entry.start_break.toISOString(), "2026-07-20T10:30:00.000Z");
    const [day] = await rows("select * from public.attendance_daily_summary");
    assert.equal(Number(day.gross_seconds), 9 * 3600);
    assert.equal(Number(day.break_seconds), 3600);
    assert.equal(Number(day.net_hours), 8);
  });
});

test("Auswertung zählt offene Buchungen nicht als bestätigte Arbeitszeit", async () => {
  await asUser(async () => {
    await db.exec("select public.log_attendance_clockin(1)");
    const [summary] = await rows("select * from public.attendance_totals");
    assert.equal(Number(summary.net_hours), 0);
    assert.equal(Number(summary.open_entries), 1);
  });
});

test("Team-Auswertung: direkte Mitarbeiter sichtbar, keine Enkelteams und keine fremden Schreibrechte", async () => {
  await asUser(async () => {
    await db.exec("update public.users set vorgesetzter = 1 where id = 2");
    const [grandchild] = await rows("insert into public.users(fullname,email,vorgesetzter) values('Grandchild','grandchild@example.test',2) returning id");
    const [empty] = await rows("insert into public.users(fullname,email,vorgesetzter) values('No entries','empty@example.test',1) returning id");
    for (const user of [1, 2, grandchild.id]) {
      await db.query("insert into public.anwesenheit(user_id,start_at,end_at,is_clock_entry) values($1,'2026-07-20T08:00:00+02:00','2026-07-20T17:00:00+02:00',true)", [user]);
    }
    await db.exec("set local role authenticated");
    const summary = await rows("select * from public.attendance_totals order by user_id");
    assert.deepEqual(summary.map(row => row.user_id), [1, 2, empty.id]);
    assert.deepEqual(summary.map(row => Number(row.net_hours)), [8, 8, 0]);
    const [period] = await rows("select public.get_attendance_summary('2026-07-20','2026-07-20') as result");
    assert.deepEqual(period.result.employees.map((row: any) => row.user_id), [1, 2, empty.id]);
    const [activity] = await rows("select public.get_my_activity('2026-07-20','2026-07-20') as result");
    assert.equal(activity.result.attendance.length, 1);
    assert.equal(activity.result.attendance[0].user_id, 1);
    assert.equal((await rows("update public.anwesenheit set end_at = clock_timestamp() where user_id = 2 returning id")).length, 0);
    await db.exec("savepoint forbidden");
    await assert.rejects(db.exec("select public.log_sickleave_single_day(2,'2026-10-22')"), (e: any) => e.code === "42501");
    await db.exec("rollback to savepoint forbidden");
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [bob]);
    assert.deepEqual((await rows("select user_id from public.attendance_totals order by user_id")).map(r => r.user_id), [2, grandchild.id]);
  }, "service_role");
  await assert.rejects(asUser(() => db.exec("select * from public.attendance_totals"), "anon"), (e: any) => e.code === "42501");
});

test("Agenten-Retry ist idempotent und explizites Clock-in kann nicht ausstempeln", async () => {
  await asUser(async () => {
    const args = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "clock_in", {}];
    const first = (await db.query("select public.agent_execute($1,$2,$3) as result", args)).rows;
    const replay = (await db.query("select public.agent_execute($1,$2,$3) as result", args)).rows;
    assert.deepEqual(replay, first);
    assert.equal((await rows("select * from public.anwesenheit"))[0].end_at, null);
    await db.exec("savepoint duplicate_action");
    await assert.rejects(db.exec("select public.agent_execute('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','clock_in','{}')"), (e: any) => e.code === "PT409");
    await db.exec("rollback to savepoint duplicate_action");
    assert.equal((await rows("select * from public.anwesenheit"))[0].end_at, null);
    const [end] = await rows("select public.agent_execute('cccccccc-cccc-4ccc-8ccc-cccccccccccc','clock_out','{}') as result");
    assert.equal(end.result.action, "clock_out");
    assert.equal((await rows("select * from timestone_private.agent_requests")).length, 2);
  });
});

test("Agenten können keine fremde Identität, neue Payload unter alter ID oder zukünftige Arbeitszeit speichern", async () => {
  await asUser(async () => {
    await db.exec(`select public.agent_execute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','log_vacation_single_day','{"date":"2027-01-04"}')`);
    const [vacation] = await rows("select * from public.urlaube");
    assert.equal(vacation.user_id, 1);
    assert.equal(vacation.is_approved, false);
    for (const sql of [
      `select public.agent_execute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','log_vacation_single_day','{"date":"2027-01-05"}')`,
      `select public.agent_execute('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','log_vacation_single_day','{"date":"2027-01-05","user":2}')`,
      `select public.agent_execute('cccccccc-cccc-4ccc-8ccc-cccccccccccc','log_attendance_without_break',jsonb_build_object('start',clock_timestamp() + interval '1 day','end',clock_timestamp() + interval '2 days'))`,
    ]) {
      await db.exec("savepoint invalid_agent");
      await assert.rejects(db.exec(sql));
      await db.exec("rollback to savepoint invalid_agent");
    }
    assert.equal((await rows("select * from public.urlaube")).length, 1);
    assert.equal((await rows("select * from timestone_private.agent_requests")).length, 1);
  });
});

// Vacation authorization fixtures are isolated and rolled back per test.
async function vacationFixture(fn: () => Promise<void>, actor = alice) {
  await asUser(async () => {
    await db.exec(`update public.users set vorgesetzter=1 where id=2;
      insert into public.urlaube(user_id,date,is_approved) values
      (1,'2027-02-01',false),(1,'2027-02-02',true),
      (2,'2027-02-01',false),(2,'2027-02-02',true);`);
    await db.exec('set local role authenticated');
    await fn();
  }, 'service_role', actor);
}
const vacationCall = async (op: string, args: unknown, request = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd') =>
  (await db.query<any>('select public.vacation_execute($1,$2,$3) as result', [request, op, args])).rows[0].result;
const vacationId = async (user: number, approved: boolean) =>
  (await db.query<any>('select id from public.urlaube where user_id=$1 and is_approved=$2', [user, approved])).rows[0].id;

test('Urlaub: eigene offene Anträge löschen, Retry löscht keinen Ersatzantrag', async () => {
  await vacationFixture(async () => {
    const id = await vacationId(1, false);
    const first = await vacationCall('cancel_vacation', { ids: [id] });
    assert.equal(first.count, 1);
    await db.exec("select public.log_vacation_single_day(1,'2027-02-01')");
    assert.deepEqual(await vacationCall('cancel_vacation', { ids: [id] }), first);
    assert.equal((await rows('select * from public.urlaube where user_id=1')).length, 2);
    await db.exec('savepoint reused');
    await assert.rejects(vacationCall('cancel_vacation', { ids: [id + 1] }), (e: any) => e.code === 'PT409');
    await db.exec('rollback to savepoint reused');
  });
});

test('Urlaub: eigene genehmigte, fremde offene und unbekannte IDs verhindern gesamte Rücknahme', async () => {
  await vacationFixture(async () => {
    const own = await vacationId(1, false);
    for (const forbidden of [await vacationId(1, true), await vacationId(2, false), 2147483647]) {
      await db.exec('savepoint denied');
      await assert.rejects(vacationCall('cancel_vacation', { ids: [own, forbidden] }), (e: any) => e.code === 'PT409');
      await db.exec('rollback to savepoint denied');
      assert.equal((await rows('select * from public.urlaube')).length, 4);
      assert.equal((await rows('select * from timestone_private.agent_requests')).length, 0);
    }
    assert.equal((await rows('delete from public.urlaube where user_id=1 and is_approved returning id')).length, 0);
    assert.equal((await rows('delete from public.urlaube where user_id=2 and not is_approved returning id')).length, 0);
  });
});

test('Urlaub: direkter Manager ändert/löscht genehmigte Teamtage, ohne Eigentümer oder Status zu ändern', async () => {
  await vacationFixture(async () => {
    const id = await vacationId(2, true);
    const changed = await vacationCall('update_approved_vacation', { id, date: '2027-02-03', wholeday: 0.5 });
    assert.equal(changed.user_id, 2);
    assert.equal(changed.is_approved, true);
    assert.equal(Number(changed.wholeday), 0.5);
    assert.deepEqual(await vacationCall('update_approved_vacation', { id, date: '2027-02-03', wholeday: 0.5 }), changed);
    for (const field of ['user_id=1', 'is_approved=false']) {
      await db.exec('savepoint forbidden_column');
      await assert.rejects(db.exec(`update public.urlaube set ${field} where id=${id}`), (e: any) => e.code === '42501');
      await db.exec('rollback to savepoint forbidden_column');
    }
    assert.equal((await vacationCall('cancel_vacation', { ids: [id] }, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')).count, 1);
  });
});

test('Urlaub: keine Änderungen eigener genehmigter oder offener Teamtage, Konflikte rollen zurück', async () => {
  await vacationFixture(async () => {
    for (const id of [await vacationId(1, true), await vacationId(1, false), await vacationId(2, false)]) {
      await db.exec('savepoint denied_update');
      await assert.rejects(vacationCall('update_approved_vacation', { id, date: '2027-02-05', wholeday: 1 }), (e: any) => e.code === 'PT409');
      await db.exec('rollback to savepoint denied_update');
    }
    await db.exec('savepoint overlap');
    await assert.rejects(vacationCall('update_approved_vacation', { id: await vacationId(2, true), date: '2027-02-01', wholeday: 1 }), (e: any) => e.code === '23505');
    await db.exec('rollback to savepoint overlap');
    assert.equal((await rows('select * from timestone_private.agent_requests')).length, 0);
  });
});

test('Urlaub: Teamzugriff endet bei direkten Mitarbeitern; anonyme Aufrufe ausgeschlossen', async () => {
  await asUser(async () => {
    await db.exec("update public.users set vorgesetzter=1 where id=2");
    const [child] = await rows("insert into public.users(fullname,email,vorgesetzter) values('Child','vacation-child@example.test',2) returning id");
    const [other] = await rows("insert into public.users(fullname,email) values('Other','vacation-other@example.test') returning id");
    for (const user of [1,2,child.id,other.id]) await db.query("insert into public.urlaube(user_id,date,is_approved) values($1,'2027-03-01',true)", [user]);
    const hidden = await rows(`select id from public.urlaube where user_id in (${child.id},${other.id})`);
    await db.exec('set local role authenticated');
    const [list] = await rows("select public.get_vacations('2027-03-01','2027-03-01') as result");
    assert.deepEqual(list.result.map((x: any) => x.user_id), [1,2]);
    for (const {id} of hidden) {
      await db.exec('savepoint hidden');
      await assert.rejects(vacationCall('cancel_vacation', { ids: [id] }), (e: any) => e.code === 'PT409');
      await db.exec('rollback to savepoint hidden');
      assert.equal((await rows(`update public.urlaube set wholeday=0.5 where id=${id} returning id`)).length,0);
    }
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [bob]);
    assert.equal((await rows('select * from public.urlaube where user_id=1')).length,0);
  }, 'service_role');
  await assert.rejects(asUser(() => vacationCall('cancel_vacation', { ids: [1] }), 'anon'), (e: any) => e.code === '42501');
  await assert.rejects(asUser(() => rows("select public.get_vacations('2027-01-01','2027-01-02')"), 'anon'), (e: any) => e.code === '42501');
});

test('Urlaub: RPC prüft ungültige IDs/Argumente auch ohne Edge-Validierung', async () => {
  for (const args of [{ids:[]},{ids:[1,1]},{ids:[null]},{ids:[1.5]},{ids:['1']},{ids:[1],user:2},{}]) {
    await assert.rejects(asUser(() => vacationCall('cancel_vacation', args)), (e: any) => e.code === '22023');
  }
});

test('Berechtigungen: User ohne Team; Manager nur aus aktueller Vorgesetztenzuordnung', async () => {
  await asUser(async () => {
    const [report] = await rows('select public.get_my_permissions() as result');
    assert.equal(report.result.role,'User');
    assert.equal(report.result.permissions.length,9);
    assert.ok(report.result.permissions.every((p: any) => !p.code.endsWith('_team')));
  });
  await asUser(async () => {
    await db.exec('update public.users set vorgesetzter=1 where id=2; set local role authenticated');
    const [manager] = await rows('select public.get_my_permissions() as result');
    assert.equal(manager.result.role,'Manager');
    assert.equal(manager.result.permissions.length,14);
    assert.ok(manager.result.permissions.some((p: any) => p.code === 'vacation.update_approved_team'));
    assert.ok(!manager.result.permissions.some((p: any) => p.code.includes('approve') && !p.code.includes('approved_team')));
    // A manager's direct report is not automatically a manager.
    await db.query("select set_config('request.jwt.claim.sub',$1,true)",[bob]);
    assert.equal((await rows('select public.get_my_permissions() as result'))[0].result.role,'User');
    await db.exec('set local role service_role; update public.users set vorgesetzter=null where id=2; set local role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,true)",[alice]);
    assert.equal((await rows('select public.get_my_permissions() as result'))[0].result.role,'User');
  },'service_role');
});

test('Berechtigungen: kein Zugriff ohne Auth oder Mitarbeiterzuordnung', async () => {
  await assert.rejects(asUser(() => rows('select public.get_my_permissions()'), 'anon'), (e: any) => e.code === '42501');
  await assert.rejects(asUser(() => rows('select public.get_my_permissions()'), 'authenticated', '99999999-9999-4999-8999-999999999999'), (e: any) => e.code === '42501');
});

test('Admin: geschuetzte Rolle, globale Erfassung/Auswertung und Urlaubsverwaltung', async () => {
  await db.exec('begin');
  try {
    await db.query('insert into timestone_private.app_admins(auth_user_id) values($1)',[alice]);
    await db.query("select set_config('request.jwt.claim.sub',$1,true)",[alice]);
    await db.exec(`insert into public.urlaube(user_id,date,is_approved) values(1,'2027-04-01',true),(2,'2027-04-01',false);
      set local role authenticated;`);
    const [report] = await rows('select public.get_my_permissions() as result');
    assert.equal(report.result.role,'Admin');
    assert.ok(report.result.permissions.some((p: any) => p.code === 'activity.create_all'));
    assert.equal((await rows('select public.get_employees() as result'))[0].result.length,2);
    const own = await vacationId(1,true);
    const other = await vacationId(2,false);
    await vacationCall('update_approved_vacation',{id:other,date:'2027-04-02',wholeday:0.5});
    const cancelled = await vacationCall('cancel_vacation',{ids:[own,other]},'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    assert.equal(cancelled.count,2);
    const args=['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','log_vacation_single_day',{user:2,date:'2027-04-03'}];
    const created=(await db.query<any>('select public.agent_execute($1,$2,$3) as result',args)).rows[0].result;
    assert.equal(created[0].user_id,2);
    assert.equal(created[0].is_approved,false);
    assert.deepEqual((await db.query<any>('select public.agent_execute($1,$2,$3) as result',args)).rows[0].result,created);
    const activity=(await rows("select public.get_employee_activity(2,'2027-04-01','2027-04-30') as result"))[0].result;
    assert.equal(activity.vacation.length,1);
    for (const sql of [
      'select * from timestone_private.app_admins',
      `insert into timestone_private.app_admins(auth_user_id) values('${bob}')`,
      'delete from timestone_private.app_admins',
      "select public.agent_execute('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','unknown','{}')"
    ]) {
      await db.exec('savepoint guard');
      await assert.rejects(db.exec(sql));
      await db.exec('rollback to savepoint guard');
    }
    await db.query("select set_config('request.jwt.claim.sub',$1,true)",[bob]);
    assert.equal((await rows('select public.get_my_permissions() as result'))[0].result.role,'User');
    for (const sql of [
      'select public.get_employees()',
      "select public.get_employee_activity(1,'2027-04-01','2027-04-30')",
      "select public.agent_execute('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','log_vacation_single_day','{\"user\":1,\"date\":\"2027-04-04\"}')",
      `insert into timestone_private.app_admins(auth_user_id) values('${bob}')`
    ]) {
      await db.exec('savepoint forbidden');
      await assert.rejects(db.exec(sql),(e: any)=>e.code==='42501');
      await db.exec('rollback to savepoint forbidden');
    }
  } finally { await db.exec('rollback'); }
});
