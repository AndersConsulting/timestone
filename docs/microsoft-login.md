# Microsoft-Login und dauerhafte Copilot-Verbindung

**Optionaler späterer Ausbau.** Der aktuelle Standard ist [E-Mail und Passwort](password-login.md). Die Login-Seite unter `auth/` verwendet jetzt `signInWithPassword`; die folgenden Microsoft-Schritte sind für den aktuellen Betrieb nicht erforderlich. Für eine spätere Reaktivierung des Microsoft-Providers muss der entsprechende Login-Aufruf in der Oberfläche wieder ergänzt werden.

Gewählter Weg: Microsoft bestätigt das Firmenkonto, Supabase stellt persönliche OAuth-Tokens aus, Copilot verwaltet und erneuert seine eigene Verbindung. Timestone verwendet weiter Supabase Auth und die bestehenden RLS-Regeln. Kein Entra-OBO-Umbau und kein Service-Role-Schlüssel für Benutzerzugriffe.

## Stand und benötigte Werte

Im Repository ist die Login-/Freigabeseite unter `auth/` implementiert. Der statische Build liegt nach `npm run auth:build` unter `dist/auth`. Die Seite verwendet die bereits installierte Supabase-Bibliothek, PKCE und die Supabase-OAuth-Consent-API. Sie baut keinen eigenen Tokenserver.

Noch einzurichten: Entra-App, Microsoft-Provider, HTTPS-Hosting, Supabase OAuth Server und persönliche Copilot-Verbindung. Ein echter Login samt automatischem Token-Refresh wurde noch nicht getestet. Die Entra-App existiert laut Rückmeldung noch nicht. Für diesen Weg wird **eine Entra-App** für den Microsoft-Login benötigt; der OAuth-Client für Copilot wird separat **in Supabase** registriert.

| Wert | Herkunft / Verwendung |
| --- | --- |
| Supabase-Projekt | `https://wbcdfvkezaqfugtgvgql.supabase.co` |
| `LOGIN_ORIGIN` | Eigene HTTPS-Adresse für `dist/auth`, z. B. `https://login.example.com`; Beispiel ersetzen |
| Microsoft Tenant-ID | Firmenmandant in Entra |
| Microsoft Client-ID und Secret | Entra-App; das Secret ausschließlich in Supabase hinterlegen |
| Supabase Publishable Key | Projekteinstellungen → API Keys; öffentlich, für den Browser-Build |
| Copilot Callback-URL | Von Copilot/Power Platform bei der OAuth-Einrichtung angezeigt |

## 1. Microsoft Entra registrieren

Entra → App-Registrierungen → Neue Registrierung: `Timestone Login`, nur Konten dieses Organisationsverzeichnisses (Single tenant). Web-Redirect-URI:

```text
https://wbcdfvkezaqfugtgvgql.supabase.co/auth/v1/callback
```

Tenant-ID und Client-ID notieren. Unter Zertifikate & Geheimnisse ein Client Secret erstellen; dessen **Wert**, nicht dessen ID, wird in Supabase benötigt. Ablaufdatum für die Erneuerung vormerken. Die optionale `xms_edov`-Claim nach der verlinkten Supabase-Anleitung konfigurieren, damit die Prüfung der E-Mail-Verifikation möglich ist.

Supabase → Authentication → Sign In / Providers → Azure (Microsoft): aktivieren, Client-ID und Secret hinterlegen. Azure Tenant URL auf `https://login.microsoftonline.com/<TENANT_ID>` setzen. Die Seite fordert den benötigten `email`-Scope an. Kein Microsoft-Graph-Zugriff ist für die Zeiterfassung erforderlich.

Quelle: [Supabase Microsoft-Login](https://supabase.com/docs/guides/auth/social-login/auth-azure).

## 2. Login-Seite bauen und hosten

Vom Verzeichnis `timestone` aus:

```sh
cp auth/.env.example auth/.env
# In auth/.env den echten Publishable Key einsetzen.
npm ci
npm run check
npm run auth:build
npm run auth:preview
```

Eine vorhandene `auth/.env` nicht überschreiben. Die lokale Datei ist ignoriert und enthält ausschließlich Projekt-URL und Publishable Key. Der Build lehnt Service-Role- und Secret-Keys ab. Lokale Vorschau: `http://127.0.0.1:3000` (explizit IPv4, damit keine andere lokale App auf IPv6 angesprochen wird). Ein unbekannter Microsoft-Provider verhindert noch die tatsächliche Anmeldung, nicht die Vorschau.

Das **gesamte Verzeichnis `dist/auth`** auf einem HTTPS-Static-Host veröffentlichen. Der Build enthält die Routen `/`, `/oauth/consent` und `/oauth/callback` als eigene Verzeichnisse; alternativ kann der Host diese Routen auf `index.html` umschreiben. Query-Parameter müssen bei Weiterleitungen erhalten bleiben. Assets liegen im Wurzelverzeichnis, deshalb auf einer eigenen Origin ohne Unterpfad hosten.

Der Build liefert `_headers` für unterstützende Hosts mit. Andernfalls dieselben Sicherheits- und Cache-Header in der Hosting-Konfiguration setzen. Keine Analytics-/Drittskripte auf der Login-Origin einbauen. Supabase Edge Functions sind hier nicht als HTML-Host vorgesehen.

Supabase → Authentication → URL Configuration:

| Einstellung | Wert |
| --- | --- |
| Site URL | `LOGIN_ORIGIN` |
| Zusätzliche Redirect URL | `LOGIN_ORIGIN/oauth/callback` |
| Nur für Entwicklung | `http://127.0.0.1:3000/oauth/callback` |

Der Microsoft-Callback in Entra und dieser Browser-Callback in Supabase sind zwei unterschiedliche Adressen. Beim Microsoft-Login bleibt die OAuth-Anfrage im Tab gespeichert. Der Browser muss beim Callback denselben Sitzungsspeicher verwenden; nicht in ein anderes Browserfenster kopieren.

## 3. Mitarbeiter zuordnen

Die vorhandene `users.auth_user_id`-Zuordnung bleibt verbindlich. Kein automatisches Zuordnen nach einer frei übergebenen E-Mail-Adresse und keine zusätzliche Schreibberechtigung für `users`.

Falls neue Auth-Anmeldungen deaktiviert sind, müssen Accounts vorab administrativ bereitgestellt werden. Alternativ neue Benutzer erst nach Beschränkung des Microsoft-Providers auf den Firmenmandanten zulassen. Andere öffentliche Signup-/anonyme Login-Wege nicht dafür öffnen. Eine erfolgreiche Microsoft-Anmeldung allein gewährt weiterhin keine Mitarbeiterdaten.

Beim ersten Aufruf von `LOGIN_ORIGIN` anmelden. Ohne Zuordnung zeigt die Seite die Auth-Kontokennung. Ein Administrator verknüpft diese in der bestehenden Mitarbeiterzeile mit `auth_user_id`; das Vorgehen für neue Mitarbeiter steht in der README. Anschließend die Verbindung in Copilot neu starten. Auch spätere Mitarbeiter benötigen diese Zuordnung, jedoch kein Timestone-Passwort.

Die Kontrolle in der Login-Seite ist eine hilfreiche Vorprüfung; die verbindliche Zugriffskontrolle bleibt RLS in der Datenbank. Vorgesetzte behalten die bereits eingerichteten Leserechte auf ihr direktes Team.

## 4. Supabase als OAuth-Anbieter aktivieren

Authentication → OAuth Server aktivieren, Authorization Path `/oauth/consent`. Zusammen mit der Site URL ergibt das `LOGIN_ORIGIN/oauth/consent`. Für OIDC (`openid`) einen asymmetrischen JWT-Signaturschlüssel verwenden; vorhandene Schlüssel nicht vorschnell widerrufen.

Unter Authentication → OAuth Apps einen Client `Timestone Copilot` registrieren. Für die manuelle Copilot-Konfiguration einen vertraulichen Client mit Client-ID/Secret verwenden. Als Redirect-URI exakt die von Copilot erzeugte Callback-URL registrieren. Das Supabase-Client-Secret gehört ausschließlich in die Copilot-Verbindung; es ist nicht das Microsoft-Client-Secret.

Der neue Client benötigt Authorization-Code- und Refresh-Token-Grant. Dynamic Client Registration ist für diesen manuellen Weg nicht erforderlich.

Quelle: [Supabase OAuth-Server einrichten](https://supabase.com/docs/guides/auth/oauth-server/getting-started).

## 5. Copilot Studio verbinden

Tools → Add a tool → New tool → Model Context Protocol. Server-URL:

```text
https://wbcdfvkezaqfugtgvgql.supabase.co/functions/v1/mcp
```

OAuth 2.0 → Manual:

| Feld | Wert |
| --- | --- |
| Client-ID / Secret | Der OAuth-App aus **Supabase** |
| Authorization URL | `https://wbcdfvkezaqfugtgvgql.supabase.co/auth/v1/oauth/authorize` |
| Token URL | `https://wbcdfvkezaqfugtgvgql.supabase.co/auth/v1/oauth/token` |
| Refresh URL | Gleiche URL wie Token URL |
| Scopes | `openid email profile` |

Die erzeugte Callback-URL in der Supabase-OAuth-App ergänzen, dann die Verbindung herstellen und die Tools dem Agenten hinzufügen. Endbenutzer verwenden ihre persönliche Verbindung. Keine gemeinsame Maker-/Administratorverbindung für Mitarbeiter einrichten.

Quelle: [Copilot Studio: MCP und OAuth](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent).

## 6. Anmeldung und Refresh prüfen

1. Mit einem normalen Mitarbeiter im veröffentlichten Agenten verbinden. Microsoft-Anmeldung und Freigabe der Anwendung abschließen.
2. `get_me` aufrufen und das erwartete Mitarbeiterprofil prüfen. Mit einem zweiten Mitarbeiter wiederholen; er darf nicht das Profil des ersten erhalten.
3. Eine erlaubte Leseabfrage testen. Für den ersten Test keine Arbeitszeiten schreiben.
4. Nach Ablauf des Access Tokens erneut aufrufen. Die Copilot-Verbindung muss den Refresh-Token verwenden und einen ggf. rotierten Refresh-Token speichern. Auch in einem neuen Chat und nach Browserneustart prüfen.
5. Die Verbindung testweise widerrufen/trennen und prüfen, dass sie nicht weiter erneuert werden kann. Bereits ausgestellte Access Tokens können bis zu ihrem Ablauf gültig bleiben.

Die Browser-Sitzung der Login-Seite ist absichtlich tabgebunden. Das Schließen dieses Tabs beendet **nicht** die separat gespeicherte OAuth-Verbindung in Copilot. „Anderes Konto verwenden“ meldet nur die lokale Browser-Sitzung ab.

Eine tägliche Neuanmeldung ist kein eingebautes Erfordernis. Widerruf, Zeitlimits, Inaktivitätslimits und Sicherheitsrichtlinien können jedoch erneute Interaktion auslösen. Nicht allein aus einem erfolgreichen Erstlogin auf funktionierenden Refresh schließen; dieser muss im tatsächlichen Copilot-Kanal getestet werden.

Quellen: [Supabase OAuth-Refresh](https://supabase.com/docs/guides/auth/oauth-server/oauth-flows), [Supabase-Sitzungen](https://supabase.com/docs/guides/auth/sessions).

## Fehler einordnen

| Beobachtung | Prüfen |
| --- | --- |
| Microsoft lehnt Redirect ab | Entra-Redirect auf Supabase `/auth/v1/callback` |
| Callback landet auf falscher Seite | Site URL, Redirect-Allowlist und Static-Host-Routing |
| Microsoft-Provider nicht verfügbar | Azure-Provider, Tenant-ID, Secret und dessen Ablauf |
| Mitarbeiterprofil fehlt | `users.auth_user_id` administrativ zuordnen |
| OAuth `feature_disabled` | Supabase OAuth Server aktivieren |
| Verbindungsanfrage abgelaufen | Anfrage in Copilot neu starten |
| Erstlogin funktioniert, später erneute Anmeldung | Refresh URL, Client-Authentifizierung, Grant und Sitzungsregeln |

Keine Access-/Refresh-Tokens oder Client-Secrets in Fehlermeldungen, Screenshots oder Chat kopieren.
