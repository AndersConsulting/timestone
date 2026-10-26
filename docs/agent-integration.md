# Agentenanbindung

**Aktueller Einstieg:** [E-Mail-/Passwort-Login](password-login.md). Im lokalen Workspace einmal `npm run user:login -- lh@andersconsulting.com` ausführen; danach liefert `npm run user:attendance -- 2026-10-01 2026-10-31` die Auswertung ausschließlich über die Edge Function. Für diesen Weg ist kein Microsoft-Login und kein OAuth-Server erforderlich.

MCP-Endpunkt des verbundenen Projekts:

```text
https://wbcdfvkezaqfugtgvgql.supabase.co/functions/v1/mcp
```

Das ist die Timestone-Anwendungsschnittstelle, nicht der administrative Supabase-MCP-Server. Zugriff erfolgt im Namen des angemeldeten Mitarbeiters, ohne Service-Role-Key. Die Benutzerzuordnung über `users.auth_user_id` muss vorhanden sein.

## Werkzeuge

| Werkzeug | Zweck |
| --- | --- |
| `get_my_permissions` | Eigene Rolle und erlaubte Funktionen als ASCII-Liste |
| `get_employees` / `get_employee_activity` / `admin_execute` | Admin: Personen zuordnen, deren Daten lesen und für sie erfassen |
| `get_me` | Eigenes Profil, aktuelle Serverzeit und Zeitzone |
| `get_my_attendance_list` | Eigene Anwesenheit, Krankheit und Urlaub als fertige ASCII-Tabelle für den Chat (`from`, `to`) |
| `get_my_activity` | Eigene Buchungen, Krankheit und Urlaub in einem Datumsbereich |
| `get_attendance_summary` | Brutto-/Pausen-/Nettozeit für sich selbst und gegebenenfalls direktes Team |
| `clock_in` / `clock_out` | Explizite, getrennte Stempelaktionen mit Serverzeit |
| `log_attendance_without_break` | Tatsächlichen vollständigen Arbeitstag mit Standardpause nachtragen |
| `log_attendance_with_break` | Tatsächlichen vollständigen Arbeitstag mit eigener Pause nachtragen |
| `log_sickleave_single_day` / `log_sickleave_multiday` | Krankheit erfassen |
| `log_vacation_single_day` / `log_vacation_multiday` | Urlaub erfassen, zunächst ungenehmigt |
| `get_vacations` | Eigene und direkte Team-Urlaubstage mit IDs lesen |
| `cancel_vacation` | Eigene offene oder genehmigte direkte Team-Einträge löschen |
| `update_approved_vacation` | Genehmigten direkten Team-Urlaubstag ändern |

Alle Schreibwerkzeuge verlangen eine UUID `request_id`. Je neuer Absicht eine neue UUID; bei Wiederholung nach Netzwerkfehlern dieselbe UUID mit identischen Argumenten senden. Die RPCs `agent_execute` und `vacation_execute` speichern Aktion und Ergebnis atomar. Ein wiederholtes `clock_in` mit gleicher ID liefert das erste Ergebnis; eine neue `clock_in`-ID bei bereits offener Buchung wird abgewiesen und stempelt nicht aus. Die klassische REST-Funktion `log_attendance_clockin` bleibt ein Toggle und soll von Agenten nicht blind wiederholt werden.

Schreibwerkzeuge haben kein frei wählbares `user`-Feld. Vorgesetzte dürfen Teamzeiten nur lesen. Das Backend übernimmt die Pausenberechnung beim Schließen einer Stempelbuchung. Offene Stempelbuchungen werden am Tagesende um 00:00 Europe/Berlin geschlossen (`auto_closed = true`); der nächste Tag beginnt mit neuem Clock-in.

## Copilot in VS Code: Test mit Benutzer-Token

Die Datei [mcp.vscode.example.json](mcp.vscode.example.json) kann in die VS-Code-MCP-Konfiguration übernommen werden. Sie fragt nach einem Supabase-Benutzer-Access-Token, ohne ihn im Repository zu speichern. Niemals einen Service-Role-Key oder einen administrativen Supabase-PAT verwenden. Ein abgelaufener Benutzer-Token muss ersetzt werden; für dauerhafte Nutzung OAuth einrichten.

Die Konfiguration verwendet das VS-Code-Format mit `inputs`, nicht das portable Copilot-Format. Unterstützung der jeweiligen Copilot-Laufzeit prüfen. [Offizielle VS-Code-Konfigurationsreferenz](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

## ChatGPT und dauerhafte OAuth-Anmeldung

Die optionale Login-/Freigabeseite unter `auth/` verwendet E-Mail und Passwort. Eine gehostete MCP-Verbindung benötigt weiterhin den Supabase-OAuth-Server und eine Client-Konfiguration. Die lokale CLI-Sitzung wird nicht automatisch an ChatGPT oder Copilot übertragen. [Passwort-Login und lokale Nutzung](password-login.md); [Microsoft als späterer Ausbau](microsoft-login.md).

Der Server stellt OAuth Protected Resource Metadata unter `/functions/v1/mcp/oauth-protected-resource` bereit und verweist bei HTTP 401 über `WWW-Authenticate` darauf. Er verwendet die Supabase-Auth-Middleware zur Prüfung der Benutzer-Tokens.

Die Bereitstellung des MCP-Servers allein verbindet noch kein ChatGPT-Konto. Für den vollständigen Anmeldefluss müssen einmalig folgende Teile eingerichtet sein:

Prüfstand am 22.10.2026: MCP-Discovery liefert HTTP 200 und der geschützte MCP-Endpunkt ohne Anmeldung HTTP 401. Die Supabase-OAuth-Discovery meldet noch HTTP 404 mit `feature_disabled` / `OAuth server is disabled`. Der vollständige ChatGPT-OAuth-Login ist daher noch nicht betriebsbereit.

1. Mitarbeiter in Supabase Auth und `users` zuordnen.
2. Supabase OAuth 2.1 Server aktivieren und die Login-/Consent-Oberfläche aus `auth/` auf einer HTTPS-Origin bereitstellen; Authorization Path `/oauth/consent` konfigurieren.
3. Einen passenden OAuth-Client registrieren oder Dynamic Client Registration aktivieren; die vom Client angezeigte Redirect-URI verwenden.
4. Den oben genannten MCP-Endpunkt in ChatGPT als eigene MCP-Verbindung mit OAuth hinzufügen und sich als Mitarbeiter anmelden. Die verfügbaren Möglichkeiten hängen vom ChatGPT-Workspace ab.

Der OAuth-Anmeldefluss ist separat zu testen, bevor eine unbeaufsichtigte Automation aktiviert wird. Der automatische Tagesabschluss läuft unabhängig von ChatGPT/Copilot als Datenbank-Cron. Ein persönliches ChatGPT-/Copilot-Konto oder eine agentische Hintergrundautomatisierung ist noch nicht verbunden.

Quellen: [Supabase OAuth-Einrichtung](https://supabase.com/docs/guides/auth/oauth-server/getting-started), [Supabase MCP-Authentifizierung](https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication), [OpenAI MCP-Authentifizierung](https://developers.openai.com/plugins/build/auth), [Eigene MCP-Verbindung in ChatGPT](https://developers.openai.com/api/docs/guides/custom-mcp-server).

## Ablauf für einen Assistenten

1. `get_me` verwenden, um Identität, Serverzeit und Zeitzone zu bestimmen.
2. `get_my_activity` für den relevanten Zeitraum lesen.
3. Aus der ausdrücklichen Benutzerabsicht oder einem autorisierten, verlässlichen Ereignis die Aktion bestimmen. Keine Arbeitszeit aus einem bloßen Kalendertermin ableiten.
4. Neue `request_id` erzeugen und das passende Schreibwerkzeug aufrufen. Für technische Retries dieselbe ID beibehalten.
5. Ergebnis und gegebenenfalls Auswertung lesen; Konflikte klären, statt mit neuen IDs weitere Schreibversuche auszulösen.

Beispielbefehle nach erfolgreicher Verbindung: „Stemple mich ein“, „Stemple mich aus“, „Trage für nächsten Montag einen halben Urlaubstag ein“, „Wie viele Stunden habe ich diese Woche gearbeitet?“, „Zeige meine Anwesenheiten dieser Woche als Tabelle“. Für die letzte Anfrage `get_my_attendance_list` mit dem aufgelösten Datumsbereich verwenden und den zurückgegebenen Codeblock unverändert anzeigen. Urlaub und Krankheit sind die aktuelle Planungsgrundlage; geplante Arbeitsschichten kommen später.

## Urlaubsanträge zurückziehen und genehmigten Urlaub ändern

Ab der Migration `vacation_management` und MCP-Version 0.4.0:

- `get_vacations(from, to)` liest eigene Urlaubstage und Urlaubstage des direkten
  Teams, einschließlich `id`, `user_id`, `fullname`, `date`, `wholeday`, `is_approved`.
- `cancel_vacation(request_id, ids)` löscht genau die angegebenen Einträge.
  Mitarbeitende dürfen eigene **nicht genehmigte** Anträge löschen. Direkte
  Vorgesetzte dürfen **genehmigte** Einträge ihrer Teammitglieder löschen.
- `update_approved_vacation(request_id, id, date, wholeday)` ändert als direkter
  Vorgesetzter Datum und Umfang (0.5/1) eines genehmigten Team-Eintrags.
  Eigentümer und Genehmigungsstatus bleiben unverändert.
- Erstellen bleibt auf eigene, nicht genehmigte Anträge beschränkt. Offene Anträge
  werden bei Bedarf vom Eigentümer gelöscht und neu erstellt. Manager erhalten
  keine Änderungs-/Löschrechte an offenen fremden Anträgen und keine Sonderrechte
  für eigene genehmigte Einträge. Indirekte Teams bleiben ausgeschlossen.
- Eine Genehmigungsfunktion ist nicht Bestandteil dieser Erweiterung.

Vor jeder Rücknahme/Änderung den gewünschten Zeitraum lesen und die konkreten IDs
zuordnen. Bei unklarer Person oder Zeitraum nachfragen. Bei gemischten oder
inzwischen geänderten Einträgen keine eigenständige Teilrücknahme durchführen:
Sobald eine ID fehlt oder nicht gelöscht werden darf, wird die **gesamte**
Löschanfrage zurückgerollt. Bei Konflikt Zustand neu lesen und dem Benutzer erklären.
Erfolg nur nach erfolgreichem Tool-Ergebnis melden.

Je Aktion eine neue UUID als `request_id`; bei technischen Wiederholungen dieselbe
UUID und identische Argumente benutzen. Löschung und Empfangsbeleg werden atomar
gespeichert. Ein Retry löscht keinen später für dasselbe Datum neu angelegten Antrag.

Die gleichnamigen Edge Functions akzeptieren POST/JSON mit denselben Argumenten
(ohne frei wählbare Benutzer-ID). `get_vacations` benötigt nur `from` und `to`.
Sie prüfen die Anmeldung und reichen den User-JWT an die SECURITY-INVOKER-RPCs
weiter. RLS schützt dieselben Rechte auch bei direkten REST-Zugriffen.

Deployment: zuerst die Migration anwenden, dann `get_vacations`, `cancel_vacation`,
`update_approved_vacation` und die aktualisierte `mcp` Edge Function veröffentlichen.
Anschließend die Tool-Liste in Copilot Studio aktualisieren und den Agenten neu
veröffentlichen. Alte Instructions „nur eigene Daten schreiben“ für Urlaub durch
obige Regeln ersetzen; für Anwesenheit und Krankheit bleibt die Beschränkung bestehen.

## Get Berechtigungen

`get_my_permissions()` (Anzeigename **Get Berechtigungen**) liefert einen fertigen
ASCII-Codeblock mit `Du bist: User`, `Du bist: Manager` oder `Du bist: Admin`
und den tatsächlich implementierten Funktionen. Im Chat unverändert ausgeben.
Keine Parameter: Weder Benutzer-ID noch gewünschte Rolle können übergeben werden.
Die gleichnamige Edge Function akzeptiert POST `{}` mit User-JWT und gibt
`role`, `permissions` (stabile Codes und Beschriftungen), `notes` und `text` zurück.

Rollenbestimmung, in dieser Reihenfolge:

1. **Admin:** Auth-UUID ist in der geschützten Tabelle
   `timestone_private.app_admins` hinterlegt.
2. **Manager:** Mindestens ein Mitarbeiter hat den angemeldeten Benutzer als
   `vorgesetzter`. Es gelten nur direkte Teamzuordnungen.
3. **User:** Zugeordnetes Mitarbeiterprofil ohne die obigen Merkmale.

Ohne zugeordnetes Mitarbeiterprofil wird die Anfrage abgelehnt. Die Anzeige ist
nur eine Auskunft; jede Aktion wird weiterhin durch RLS autorisiert. Die Rolle
wird niemals aus E-Mail-Text, Prompts oder editierbaren Auth-Metadaten abgeleitet.

Admins haben die vorhandenen Erfassungs- und Leserechte für alle Mitarbeitenden,
können auch eigene genehmigte und fremde offene Urlaubstage ändern/löschen:

- `get_employees()` liefert Mitarbeiter-ID, Namen und E-Mail zur eindeutigen Zuordnung.
- `get_employee_activity(user, from, to)` liest Zeiten, Krankheit und Urlaub einer Person.
- `admin_execute(request_id, user, operation, arguments)` verwendet die vorhandenen
  acht Erfassungs-/Stempeloperationen für diese Person. Identität und Berechtigung
  prüft die Datenbank; technische Wiederholungen verwenden dieselbe Anfrage-ID.
- `get_attendance_summary` und `get_vacations` umfassen für Admins alle Mitarbeitenden.
- `cancel_vacation` und `update_approved_vacation` gelten für Admins auch für offene
  und eigene Urlaubstage. Genehmigungsstatus und Eigentümer bleiben unverändert.

Es entstehen dadurch keine neuen Agentenfunktionen zur Urlaubsgenehmigung,
Rollenvergabe oder allgemeinen Bearbeitung/Löschung von Krankheit und Anwesenheit.
Neue Urlaubsanträge bleiben ungenehmigt. Für User/Manager gelten weiterhin die
Regeln aus dem vorherigen Abschnitt; Admin ist die explizite Ausnahme.

Die Migration `admin_access` sieht auf ausdrücklichen Auftrag diese Konten vor:
`lh@andersconsulting.com`, `fa@andersconsulting.com`, `sh@andersconsulting.com`.
Sie übernimmt ausschließlich bereits vorhandene Auth-UUIDs mit passendem
Mitarbeiterdatensatz und übereinstimmender Auth-/Mitarbeiter-E-Mail. Nicht vorhandene
oder nicht zugeordnete Konten werden nicht erstellt und erhalten keine Rolle.
Beim Deployment die drei Zuweisungen prüfen. Spätere Rollenvergaben erfolgen nur
über eine administrative Migration; eine Änderung der Profil-E-Mail vergibt keine Rolle.

Deployment-Reihenfolge: `vacation_management`, `permissions_report`, `admin_access`;
danach `get_my_permissions` und die aktualisierte `mcp` Edge Function (sowie die
noch ausstehenden Urlaubs-Edge-Functions) veröffentlichen. Tool-Liste und Instructions
in Copilot Studio aktualisieren, anschließend den Agenten veröffentlichen.
