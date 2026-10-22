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
| `get_me` | Eigenes Profil, aktuelle Serverzeit und Zeitzone |
| `get_my_attendance_list` | Eigene Anwesenheit, Krankheit und Urlaub als fertige ASCII-Tabelle für den Chat (`from`, `to`) |
| `get_my_activity` | Eigene Buchungen, Krankheit und Urlaub in einem Datumsbereich |
| `get_attendance_summary` | Brutto-/Pausen-/Nettozeit für sich selbst und gegebenenfalls direktes Team |
| `clock_in` / `clock_out` | Explizite, getrennte Stempelaktionen mit Serverzeit |
| `log_attendance_without_break` | Tatsächlichen vollständigen Arbeitstag mit Standardpause nachtragen |
| `log_attendance_with_break` | Tatsächlichen vollständigen Arbeitstag mit eigener Pause nachtragen |
| `log_sickleave_single_day` / `log_sickleave_multiday` | Krankheit erfassen |
| `log_vacation_single_day` / `log_vacation_multiday` | Urlaub erfassen, zunächst ungenehmigt |

Alle Schreibwerkzeuge verlangen eine UUID `request_id`. Je neuer Absicht eine neue UUID; bei Wiederholung nach Netzwerkfehlern dieselbe UUID mit identischen Argumenten senden. Der RPC `agent_execute` speichert Aktion und Ergebnis atomar. Ein wiederholtes `clock_in` mit gleicher ID liefert das erste Ergebnis; eine neue `clock_in`-ID bei bereits offener Buchung wird abgewiesen und stempelt nicht aus. Die klassische REST-Funktion `log_attendance_clockin` bleibt ein Toggle und soll von Agenten nicht blind wiederholt werden.

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
