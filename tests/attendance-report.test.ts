import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAttendanceList, type Activity } from "../supabase/functions/_shared/attendance-report.ts";

test("ASCII-Liste: echte Wochentage, Nettozeit, halbe Abwesenheiten und Urlaubsstatus", () => {
  const activity: Activity = {
    attendance: [{ start_at: "2027-01-18T09:30:00+01:00", end_at: "2027-01-18T17:30:00+01:00", start_break: "2027-01-18T12:30:00+01:00", end_break: "2027-01-18T13:30:00+01:00" }],
    sickleave: [{ date: "2027-01-20", wholeday: 1 }, { date: "2027-01-21", wholeday: 0.5 }],
    vacation: [{ date: "2027-01-22", wholeday: 1, is_approved: false }, { date: "2027-01-23", wholeday: 0.5, is_approved: true }],
  };
  const text = formatAttendanceList(activity, "2027-01-18", "2027-01-24");
  assert.match(text, /MO\.\s*\| 18\.01\.2027\s*\| 09:30 - 17:30\s*\| 12:30 - 13:30\s*\|\s*7,00/);
  assert.match(text, /MI\.\s*\| 20\.01\.2027\s*\| KRANK\s*\| --\s*\|\s*0,00/);
  assert.match(text, /KRANK \(0,5 Tag\)/);
  assert.match(text, /URLAUB beantragt/);
  assert.match(text, /URLAUB \(0,5 Tag\) genehmigt/);
  assert.match(text, /Summe netto: 7,00 Stunden/);
  const lengths = text.split("\n").filter(line => line.startsWith("|") || line.startsWith("+")).map(line => line.length);
  assert.equal(new Set(lengths).size, 1);
});
test("ASCII-Liste: Berliner Datum statt UTC, Mitternacht und offene Zeiten", () => {
  const text = formatAttendanceList({ attendance: [
    { start_at: "2026-07-19T22:30:00Z", end_at: "2026-07-20T22:00:00Z", start_break: "2026-07-20T10:30:00Z", end_break: "2026-07-20T11:30:00Z", auto_closed: true },
    { start_at: "2026-07-21T07:00:00Z", end_at: null, start_break: null, end_break: null },
  ], sickleave: [], vacation: [] }, "2026-07-20", "2026-07-21");
  assert.match(text, /MO\.\s*\| 20\.07\.2026\s*\| 00:30 - 24:00 \*/);
  assert.match(text, /09:00 - OFFEN/);
  assert.match(text, /Summe netto: 22,50/);
  assert.match(text, /Offene Buchungen: 1/);
  assert.match(text, /Automatisch um 00:00/);
});
test("ASCII-Liste: Zeitumstellung zählt verstrichene Stunden, nicht Uhrzeiger", () => {
  for (const [start, end, expected] of [
    ["2026-03-29T00:00:00+01:00", "2026-03-30T00:00:00+02:00", "23,00"],
    ["2026-10-25T00:00:00+02:00", "2026-10-26T00:00:00+01:00", "25,00"],
  ]) {
    const text = formatAttendanceList({ attendance: [{ start_at: start, end_at: end, start_break: null, end_break: null }], sickleave: [], vacation: [] }, start.slice(0, 10), start.slice(0, 10));
    assert.match(text, new RegExp(`Summe netto: ${expected}`));
  }
});
test("ASCII-Liste: leerer Zeitraum und Summe vor Rundung", () => {
  assert.match(formatAttendanceList({ attendance: [], sickleave: [], vacation: [] }, "2026-10-01", "2026-10-31"), /Keine Eintraege/);
  const activity: Activity = { attendance: [1, 2].map(day => ({ start_at: `2026-10-0${day}T09:00:00Z`, end_at: `2026-10-0${day}T09:01:00Z`, start_break: null, end_break: null })), sickleave: [], vacation: [] };
  assert.match(formatAttendanceList(activity, "2026-10-01", "2026-10-02"), /Summe netto: 0,03/);
});
