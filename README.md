# Timestone

Supabase-Backend für Anwesenheit, Krankheit und Urlaub mit MCP-Schnittstelle für Assistenten. Speichert vollständige Arbeitstage, Stempelzeiten und Abwesenheiten; zwei Datenbank-Views zeigen die geleisteten Zeiten. Keine Weboberfläche.

## Datenmodell

Tabellen und Spalten verwenden PostgreSQL-übliche Kleinschreibung. Die fachlichen Felder sind wie folgt abgebildet:

| Tabelle | Spalten |
| --- | --- |
| `users` | `id` (Integer, automatisch), `card_id` (UUID, eindeutig, automatisch vorbelegt), `fullname`, `email` (ohne Beachtung der Groß-/Kleinschreibung eindeutig), `vorgesetzter` (optionaler Verweis auf `users.id`), `auth_user_id` (optionaler, eindeutiger Verweis auf Supabase Auth) |
| `anwesenheit` | `id`, `user_id`, `start_at`, `end_at`, `start_break`, `end_break`, `is_clock_entry` |
| `krankheit` | `id`, `user_id`, `date`, `wholeday` |
| `urlaube` | `id`, `user_id`, `date`, `wholeday`, `is_approved` |

Zeitpunkte sind `timestamptz`. Die feste Mittagspause wird in `Europe/Berlin` berechnet, einschließlich Sommer-/Winterzeit. `wholeday` ist ein exakter Zahlenwert mit ausschließlich `0.5` oder `1`; Standard ist `1`. Neue Urlaube haben `is_approved = false`.

Anwesenheiten dürfen sich pro Benutzer nicht überschneiden. Pro Benutzer und Datum gibt es höchstens einen Krankheitseintrag und höchstens einen Urlaubseintrag. Tabellenübergreifende Konflikte zwischen Krankheit, Urlaub und Anwesenheit werden in dieser Version nicht geprüft.

## Edge Functions

Alle Endpunkte: `POST https://<PROJECT_REF>.supabase.co/functions/v1/<NAME>`.

Erforderliche Header:

```text
Authorization: Bearer <SUPABASE_USER_ACCESS_TOKEN>
apikey: <SUPABASE_PUBLISHABLE_KEY>
Content-Type: application/json
```

Der Access Token stammt aus einer Supabase-Auth-Anmeldung. API-Schlüssel oder CardID ersetzen diesen Login nicht. Funktionen prüfen den Benutzer über Auth und geben seinen JWT an die Datenbank weiter. RLS erlaubt nur das Erfassen eigener Daten. Vorgesetzte können zusätzlich Profile und Anwesenheit ihres direkten Teams lesen, aber nichts für ihr Team schreiben. Krankheit und Urlaub bleiben nur für die jeweilige Person sichtbar.

| Funktion | JSON-Felder |
| --- | --- |
| `log_attendance_without_break` | `user`, `start`, `end` |
| `log_attendance_with_break` | `user`, `start`, `end`, `startBreak`, `endBreak` |
| `log_attendance_clockin` | `user` |
| `log_sickleave_single_day` | `user`, `date`, optional `wholeday` |
| `log_sickleave_multiday` | `user`, `from`, `to`, optional `wholeday` |
| `log_vacation_single_day` | `user`, `date`, optional `wholeday` |
| `log_vacation_multiday` | `user`, `from`, `to`, optional `wholeday` |

`user` ist die Integer-ID aus `users`, nicht die Auth-UUID. Nicht aufgeführte Felder werden abgewiesen. Zeiten müssen ISO-8601 mit Sekunden und Zeitzone sein; Datumsfelder `YYYY-MM-DD`.

### Ein- und Ausstempeln

`log_attendance_clockin` verwendet für beide Aktionen denselben Request:

```json
{"user": 1}
```

Der Server verwendet seine aktuelle Uhrzeit und den Kalendertag in `Europe/Berlin`:

1. Noch keine Anwesenheit an diesem Tag: Eintrag mit `start_at = jetzt`, `end_at = null` anlegen. Antwort enthält `data.action = "clock_in"`.
2. Offene Stempelbuchung von heute: Denselben Eintrag mit `end_at = jetzt` schließen. Antwort enthält `data.action = "clock_out"`.
3. Bereits abgeschlossener Tag: HTTP `409`; die gespeicherte Endzeit bleibt erhalten. Auch ein bereits manuell vollständig gebuchter Tag wird abgewiesen.

Die Antwort enthält zusätzlich `data.attendance` mit dem Datensatz. Beim Ausstempeln berechnet die Datenbank eine **automatische Pause von 12:30–13:30 Uhr**, wenn alle Bedingungen erfüllt sind:

- Die Zeit zwischen Beginn und Ende ist **größer als sieben Stunden** (Bruttozeit vor Pausenabzug).
- Beginn ist spätestens um 12:30 Uhr in `Europe/Berlin`.
- Die volle Pause bis 13:30 Uhr liegt innerhalb des Arbeitszeitraums.

Sonst bleiben `start_break` und `end_break` `null`. Genau sieben Stunden erzeugen keine Pause; ein Beginn nach 12:30 ebenfalls nicht. Beispiel: 08:00–17:00 → 9 h brutto, 1 h Pause, 8 h netto. 13:00–21:00 → 8 h brutto/netto ohne automatische Pause. Offene Buchungen haben noch keine Pause. Stempelbuchungen sind durch `is_clock_entry = true` gekennzeichnet. Manuell vollständig erfasste Arbeitstage behalten ihre explizite Pause.

Eine offene Buchung eines früheren Tages wird mit HTTP `409` gemeldet und muss zunächst durch einen Administrator korrigiert werden. Es erfolgt kein automatisches Ausstempeln über Mitternacht. Ein neuer Tag mit bereits geschlossener Vortagsbuchung beginnt wieder mit Clock-in.

Die Entscheidung über Ein- oder Ausstempeln wird pro Benutzer innerhalb einer Datenbanktransaktion serialisiert. Jeder erfolgreiche Aufruf ist eine neue Stempelaktion: Clients sollten den Button während einer Anfrage sperren und bei unklarem Netzwerkstatus den gespeicherten Zustand prüfen, bevor sie erneut aufrufen.

Agenten verwenden stattdessen die expliziten, wiederholbaren MCP-Aktionen `clock_in` und `clock_out`; siehe [Agentenanbindung](docs/agent-integration.md).

### Anwesenheit mit Standardpause

`log_attendance_without_break` bedeutet **ohne mitgelieferte Pause**: Die Funktion trägt stets 12:30–13:30 Uhr Berliner Ortszeit ein.

```json
{"user": 1, "start": "2026-10-22T08:00:00+02:00", "end": "2026-10-22T17:00:00+02:00"}
```

Beginn und Ende müssen auf denselben Berliner Kalendertag fallen und die volle Standardpause einschließen. Für andere Schichten die Variante mit eigener Pause verwenden. Eine pausenlose Schicht ist noch nicht vorgesehen.

### Anwesenheit mit eigener Pause

```json
{
  "user": 1,
  "start": "2026-10-22T08:00:00+02:00",
  "end": "2026-10-22T17:00:00+02:00",
  "startBreak": "2026-10-22T12:00:00+02:00",
  "endBreak": "2026-10-22T12:45:00+02:00"
}
```

Die Pause muss eine positive Dauer haben und vollständig innerhalb der Arbeitszeit liegen. Diese Variante unterstützt Schichten über Mitternacht.

### Einzelner Krankheits- oder Urlaubstag

```json
{"user": 1, "date": "2026-10-23", "wholeday": 0.5}
```

### Mehrere Krankheits- oder Urlaubstage

```json
{"user": 1, "from": "2026-11-02", "to": "2026-11-06", "wholeday": 1}
```

Beide Grenzen sind eingeschlossen. Es entsteht ein Datensatz pro **Kalendertag**, einschließlich Wochenenden und Feiertagen. `wholeday` gilt für jeden Tag des Bereichs. Höchstens 366 Tage pro Request. Unterschiedliche Tagesanteile über separate Aufrufe erfassen. Bei einem Konflikt wird der gesamte Aufruf zurückgerollt; bestehende Daten werden nicht überschrieben.

Urlaubsfreigaben und Korrekturen sind noch keine öffentlichen Funktionen. `isApproved`/`is_approved` werden als Request-Felder abgewiesen. Verwaltung erfolgt vorerst durch berechtigte Administratoren im Supabase-Dashboard.

### Antworten

Erfolg: HTTP `201`, `{ "data": ... }`. Vollständige Anwesenheit liefert einen Datensatz; Abwesenheit liefert ein Array von Tagesdatensätzen. Die Stempelfunktion liefert `{ "data": { "action": "clock_in" | "clock_out", "attendance": { ... } } }`.

| Status | Bedeutung |
| --- | --- |
| `400` | Ungültige Eingaben oder ungültiger Zeitraum/Pause |
| `401` | Keine gültige Anmeldung |
| `403` | Keine Berechtigung für den angegebenen Benutzer |
| `409` | Doppelter/überlappender Eintrag, bereits abgeschlossener Tag oder offene Buchung eines früheren Tages; bestehende Daten bleiben erhalten |
| `405` / `415` / `413` | Falsche Methode / falscher Content-Type / zu große Anfrage |
| `500` / `502` | Konfigurationsfehler / Auth- oder Datenbankdienst nicht verfügbar |

Fehler haben die Form `{ "error": "..." }`. Gatewayfehler können ein anderes Format haben.

## Benutzer einrichten

1. Benutzer in Supabase Auth anlegen oder einladen.
2. Im SQL-Editor als Administrator einen Mitarbeiter mit dessen Auth-UUID anlegen:

```sql
insert into public.users (fullname, email, auth_user_id)
values ('Erika Muster', 'erika@example.com', '<AUTH-USER-UUID>'::uuid)
returning id, card_id;
```

`vorgesetzter` kann anschließend auf eine vorhandene `users.id` gesetzt werden. CardIDs können beim Anlegen explizit vorgegeben werden. Ein Benutzer darf nicht sein eigener Vorgesetzter sein. Ohne `auth_user_id` ist ein Mitarbeiterdatensatz noch keinem Login zugeordnet.

## Entwicklung und Deployment

```sh
npm ci
npm run check
```

Tests führen die echte Migration und RPCs in PGlite (PostgreSQL/WASM) aus, mit nachgebildeten Supabase-Auth-Rollen. Sie prüfen Datenbank-Constraints, RLS, Sommer-/Winterzeit und Transaktionen. HTTP-Tests prüfen die gemeinsame Edge-Logik mit simulierten Auth-/REST-Antworten. Dafür sind weder Docker noch Zugangsdaten nötig. Ein vollständiger lokaler Supabase-Stack benötigt zusätzlich Docker und die Supabase CLI.

```sh
supabase start
supabase functions serve
```

Die Edge Functions verwenden die von Supabase bereitgestellten Variablen `SUPABASE_URL` und `SUPABASE_ANON_KEY`. Es wird kein Service-Role-Schlüssel in den Funktionen verwendet. Keine Secrets ins Repository schreiben.

Remote-Deployment mit der Supabase CLI:

```sh
supabase login
supabase link --project-ref <PROJECT_REF>
supabase db push
supabase functions deploy
```

`verify_jwt = true` ist für alle sieben REST-Funktionen konfiguriert. Bei `mcp` ist der Gateway-Check aus, damit OAuth-Discovery erreichbar ist; `withSupabase({ auth: 'user' })` authentifiziert jeden MCP-Aufruf. Die Migrationen unter `supabase/migrations/` sind die Grundlage für weitere Umgebungen.

## Auswertung: Wer hat wie viel gearbeitet?

Im Supabase-Dashboard unter Database die Views `attendance_totals` (gesamt pro Person) und `attendance_daily_summary` (pro Person/Tag) öffnen. Eine eigene Weboberfläche ist nicht enthalten.

```sql
select fullname, net_hours, gross_seconds / 3600 as gross_hours,
       break_seconds / 3600 as break_hours, open_entries
from public.attendance_totals
order by fullname;

select fullname, work_date, net_hours, open_entries
from public.attendance_daily_summary
where work_date between '2026-10-01' and '2026-10-31'
order by fullname, work_date;
```

Die Views zählen nur abgeschlossene Anwesenheiten. Offene Buchungen erscheinen in `open_entries`, ohne bestätigte Stunden zu erhöhen. Urlaub und Krankheit sind keine geleistete Arbeitszeit. Schichten über Mitternacht werden dem Berliner Startdatum zugeordnet. Mitarbeitende ohne Buchungen erscheinen in `attendance_totals` mit null Stunden.

Die Views verwenden `security_invoker = true`: Über den Data API-Zugang sehen Mitarbeitende nur sich selbst, Vorgesetzte zusätzlich direkt unterstellte Personen, keine weiteren Hierarchiestufen. Das Supabase-Dashboard/der SQL-Editor arbeitet als Administrator und kann alle Daten sehen. Die Beziehung wird über `users.vorgesetzter` gepflegt. Ein RPC `get_attendance_summary(p_from,p_to)` liefert die gleiche Auswertung für einen Zeitraum von maximal 366 Tagen.

## Agentisches Gerüst

Der MCP-Endpunkt bietet 11 Werkzeuge für Profil, Auswertung, eigene Buchungen sowie Krankheit und Urlaub. Alle Schreibwerkzeuge lösen die Identität aus der Anmeldung auf und verlangen `request_id` zur Wiederholungssicherheit. Erfolgreiche Agentenaktionen werden mit Ergebnis in `timestone_private.agent_requests` protokolliert. Unterschiedliche Argumente mit derselben ID werden abgewiesen. Fehlgeschlagene Aktionen hinterlassen weder Teilbuchungen noch Erfolgsbelege.

Urlaub und Krankheit können mit Datumsbereichen geplant werden. Künftige Arbeitsschichten sind noch kein Planungsobjekt; der Agenten-RPC lehnt zukünftige Anwesenheitszeiten ab. Es gibt keine gestartete Hintergrundautomatisierung. Für echte automatische Buchungen braucht der Agent verlässliche Ereignisse und einen autorisierten Ablauf; Kalendertermine allein belegen keine tatsächliche Arbeitszeit.

Einrichtung für Copilot und ChatGPT sowie der verbleibende OAuth-Anmeldeschritt: [docs/agent-integration.md](docs/agent-integration.md).
