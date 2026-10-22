# Timestone

Supabase-Backend für Anwesenheit, Krankheit und Urlaub. Speichert vollständige Arbeitstage und Abwesenheiten sowie Ein- und Ausstempelzeiten über eine separate Funktion. Keine Oberfläche.

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

Der Access Token stammt aus einer Supabase-Auth-Anmeldung. API-Schlüssel oder CardID ersetzen diesen Login nicht. Funktionen prüfen den Benutzer über Auth und geben seinen JWT an die Datenbank weiter. RLS erlaubt nur das Lesen und Erfassen eigener Daten. Vorgesetzte erhalten in dieser Version keine zusätzlichen Rechte; die Beziehung wird zunächst nur gespeichert.

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

Die Antwort enthält zusätzlich `data.attendance` mit dem Datensatz. **Keine automatische Pause:** `start_break` und `end_break` bleiben `null`. Stempelbuchungen sind durch `is_clock_entry = true` gekennzeichnet. Die bisherigen Funktionen für vollständige Arbeitstage verlangen weiterhin Endzeit und Pause.

Eine offene Buchung eines früheren Tages wird mit HTTP `409` gemeldet und muss zunächst durch einen Administrator korrigiert werden. Es erfolgt kein automatisches Ausstempeln über Mitternacht. Ein neuer Tag mit bereits geschlossener Vortagsbuchung beginnt wieder mit Clock-in.

Die Entscheidung über Ein- oder Ausstempeln wird pro Benutzer innerhalb einer Datenbanktransaktion serialisiert. Jeder erfolgreiche Aufruf ist eine neue Stempelaktion: Clients sollten den Button während einer Anfrage sperren und bei unklarem Netzwerkstatus den gespeicherten Zustand prüfen, bevor sie erneut aufrufen.

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

`verify_jwt = true` ist für alle sieben Funktionen konfiguriert. Die Migrationen unter `supabase/migrations/` sind die Grundlage für weitere Umgebungen.
