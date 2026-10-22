# Login mit E-Mail und Passwort

Der Standard ist jetzt Supabase Auth mit E-Mail und Passwort. Die E-Mail-Adresse ist der Benutzername. Microsoft/Entra ist für diesen Weg nicht erforderlich. Die bestehenden Benutzer-JWTs und RLS-Regeln bleiben verbindlich.

## Einmalig: Konto und Mitarbeiter zuordnen

1. In Supabase unter Authentication → Users → Add user → Create new user das persönliche Konto anlegen. Für Lorenz: `lh@andersconsulting.com`. Das Passwort direkt im Formular eingeben, nicht im Chat oder im Repository.
2. Die Auth-ID des neuen Kontos kopieren. Im Table Editor den bereits vorhandenen Mitarbeiter unter `public.users` anhand der E-Mail auswählen und dessen `auth_user_id` auf genau diese ID setzen. Keine zweite Mitarbeiterzeile anlegen und keine bestehenden Zuordnungen anderer Konten überschreiben.
3. Unter Sign In / Providers muss Email aktiv sein. Das wurde im verbundenen Projekt am 22.10.2026 über `/auth/v1/settings` bestätigt. Die Anwendung bietet keine öffentliche Registrierung und ordnet Konten nicht automatisch anhand einer E-Mail zu.

Die Passwort-Anmeldung ersetzt den Microsoft-Provider. Das Anlegen des Kontos und die einmalige Zuordnung bleiben nötig, weil Mitarbeiterdatensätze und Auth-Konten getrennt sind. Das Passwort wird von Supabase verwaltet; es gibt keine eigene Passwortspalte in `public.users`.

## Im Workspace anmelden und Edge Functions aufrufen

`auth/.env` enthält nur die öffentliche Projektadresse und den Publishable Key (siehe `auth/.env.example`). Eine vorhandene Datei nicht überschreiben.

Im eigenen Terminal im Verzeichnis `timestone`:

```sh
npm run user:login -- lh@andersconsulting.com
```

Das Passwort wird verdeckt abgefragt und nicht gespeichert. Die persönliche Sitzung liegt unter `.timestone/session.json` mit Dateirechten `0600` im Verzeichnis `0700`. Der Ordner ist von Git ausgeschlossen. Die Sitzung enthält Access-/Refresh-Tokens; sie gehört nur auf den eigenen Rechner. Ein abgelaufener Access-Token wird bei einem späteren Aufruf über Supabase erneuert.

Anschließend kann auch der Assistent in diesem Workspace die Auswertung abrufen:

```sh
npm run user:attendance -- 2026-10-01 2026-10-31
```

Der Befehl überprüft die persönliche Sitzung und Mitarbeiterzuordnung und ruft `get_my_attendance_list` als Edge Function mit dem Benutzer-JWT auf. Er führt kein SQL aus. Die Ausgabe kommt aus dem Backend und enthält die ASCII-Tabelle und Netto-Summe.

```sh
npm run user:logout
```

Die Abmeldung widerruft die lokale Supabase-Sitzung und entfernt die lokale Datei. Bereits ausgegebene Access-Tokens können bis zu ihrem Ablauf gültig bleiben. Parallele CLI-Aufrufe werden durch `.timestone/session.lock` verhindert; nach einem abgebrochenen Prozess diese Datei erst entfernen, wenn kein Timestone-Aufruf mehr läuft.

## Login-Seite

```sh
npm run auth:build
npm run auth:preview
```

Unter `http://127.0.0.1:3000/` mit E-Mail und Passwort anmelden. Nach erfolgreicher Mitarbeiterzuordnung lassen sich eigene Anwesenheiten für einen Datumsbereich abrufen. Die Liste wird über dieselbe Edge Function geladen. Die Browser-Sitzung gilt für diesen Tab und ist getrennt von der lokalen CLI-Sitzung.

Für einen Zugriff außerhalb des Rechners `dist/auth` auf einer HTTPS-Origin hosten. Die Seite enthält keinen Admin-Schlüssel. Passwort vergessen: vorerst über den Administrator zurücksetzen.

## Copilot / ChatGPT

Für den lokalen Workspace genügt der CLI-Login. Eine gehostete ChatGPT-/Copilot-MCP-Verbindung erhält dadurch noch keine Sitzung. Für deren dauerhafte Verbindung ist weiterhin ein Client-Anmeldefluss erforderlich; die vorhandene optionale Supabase-OAuth-Freigabeseite verwendet nun ebenfalls den Passwort-Login. Microsoft/Entra wird dafür nicht benötigt.

Die bisherige Microsoft-Anleitung bleibt als optionaler späterer Ausbau unter [microsoft-login.md](microsoft-login.md) erhalten.

## Prüfstand

Login, Fehlerfälle, Kontowechsel, Sitzungsspeicherung, Token-Erneuerung und Edge-Weitergabe sind automatisiert getestet. Der Browser-Build wurde geprüft. Ein persönlicher Ende-zu-Ende-Test benötigt das eingerichtete Auth-Konto, die Mitarbeiterzuordnung und eine Anmeldung durch den Benutzer.

Quellen: [Supabase Passwort-Login](https://supabase.com/docs/guides/auth/passwords), [signInWithPassword](https://supabase.com/docs/reference/javascript/auth-signinwithpassword).
