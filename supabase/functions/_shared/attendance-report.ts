export type Activity = {
  attendance: {
    start_at: string; end_at: string | null;
    start_break: string | null; end_break: string | null; auto_closed?: boolean;
  }[];
  sickleave: { date: string; wholeday: number }[];
  vacation: { date: string; wholeday: number; is_approved: boolean }[];
};

const zone = "Europe/Berlin";
const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
const timeFormat = new Intl.DateTimeFormat("de-DE", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function localDay(value: string): string {
  const parts = dayFormat.formatToParts(new Date(value));
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
}
const time = (value: string) => timeFormat.format(new Date(value));
const hours = (ms: number) => (ms / 3600000).toFixed(2).replace(".", ",");
const dateLabel = (day: string) => day.split("-").reverse().join(".");
const weekday = (day: string) => ["SO.", "MO.", "DI.", "MI.", "DO.", "FR.", "SA."][new Date(`${day}T12:00:00Z`).getUTCDay()];
function relativeTime(value: string, startDay: string): string {
  const day = localDay(value);
  const days = Math.round((Date.parse(day) - Date.parse(startDay)) / 86400000);
  if (days === 1 && time(value) === "00:00" && new Date(value).getUTCSeconds() === 0 && new Date(value).getUTCMilliseconds() === 0) return "24:00";
  return time(value) + (days ? ` (+${days}T)` : "");
}

/** Format only data returned by the self-only get_my_activity RPC. */
export function formatAttendanceList(activity: Activity, from: string, to: string): string {
  const entries: { day: string; order: string; cells: string[] }[] = [];
  let total = 0;
  let open = 0;
  let auto = 0;
  for (const entry of activity.attendance) {
    const day = localDay(entry.start_at);
    const pause = entry.start_break && entry.end_break
      ? `${relativeTime(entry.start_break, day)} - ${relativeTime(entry.end_break, day)}` : "--";
    const breakMs = entry.start_break && entry.end_break ? Date.parse(entry.end_break) - Date.parse(entry.start_break) : 0;
    const net = entry.end_at ? Date.parse(entry.end_at) - Date.parse(entry.start_at) - breakMs : 0;
    total += net;
    if (!entry.end_at) open++;
    if (entry.auto_closed) auto++;
    entries.push({ day, order: entry.start_at, cells: [weekday(day), dateLabel(day),
      `${time(entry.start_at)} - ${entry.end_at ? relativeTime(entry.end_at, day) : "OFFEN"}${entry.auto_closed ? " *" : ""}`,
      pause, entry.end_at ? hours(net) : "--"] });
  }
  for (const [kind, records] of [["KRANK", activity.sickleave], ["URLAUB", activity.vacation]] as const) {
    for (const entry of records) {
      const fraction = Number(entry.wholeday) === 0.5 ? " (0,5 Tag)" : "";
      const approval = "is_approved" in entry ? (entry.is_approved ? " genehmigt" : " beantragt") : "";
      entries.push({ day: entry.date, order: kind, cells: [weekday(entry.date), dateLabel(entry.date), kind + fraction + approval, "--", "0,00"] });
    }
  }
  entries.sort((a, b) => a.day.localeCompare(b.day) || a.order.localeCompare(b.order));
  const headers = ["TAG", "DATUM", "Von - Bis", "Pause", "Stunden"];
  const rows = entries.map(entry => entry.cells);
  const widths = headers.map((title, i) => Math.max(title.length, ...rows.map(row => row[i].length)));
  const line = "+-" + widths.map(width => "-".repeat(width)).join("-+-") + "-+";
  const row = (cells: string[]) => "| " + cells.map((cell, i) => i === 4 ? cell.padStart(widths[i]) : cell.padEnd(widths[i])).join(" | ") + " |";
  return [
    `Meine Anwesenheiten: ${dateLabel(from)} - ${dateLabel(to)} (${zone})`,
    line, row(headers), line, ...rows.map(row), line,
    ...(rows.length ? [] : ["Keine Eintraege im Zeitraum."]),
    `Summe netto: ${hours(total)} Stunden`,
    ...(open ? [`Offene Buchungen: ${open} (noch nicht in der Summe).`] : []),
    ...(auto ? ["* Automatisch um 00:00 geschlossen; 24:00 bezeichnet das Tagesende."] : []),
    ...(activity.vacation.length ? ["Beantragter Urlaub ist noch nicht genehmigt."] : []),
    "Krankheit und Urlaub zaehlen nicht als geleistete Arbeitsstunden.",
  ].join("\n");
}
