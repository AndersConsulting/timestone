import { createClient } from "@supabase/supabase-js";
import { createAuthFlow, type View } from "./flow.ts";

declare const __SUPABASE_URL__: string;
declare const __SUPABASE_PUBLISHABLE_KEY__: string;

const content = document.querySelector<HTMLElement>("#content")!;
let flow: ReturnType<typeof createAuthFlow>;
let client: ReturnType<typeof createClient>;
function element(tag: string, text: string, className?: string) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(label: string, action: () => Promise<void>, secondary = false) {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = label;
  node.className = secondary ? "secondary" : "primary";
  node.addEventListener("click", () => { void action(); });
  return node;
}
function render(view: View) {
  content.replaceChildren();
  content.setAttribute("aria-busy", String(view.kind === "loading"));
  if (view.kind === "loading") {
    content.append(element("p", view.message, "status"));
    return;
  }
  if (view.kind === "error") {
    const message = element("p", view.message, "error");
    message.setAttribute("role", "alert");
    content.append(element("h1", "Verbindung nicht abgeschlossen"), message,
      element("p", "Bitte versuche es erneut. Wenn das Problem bleibt, wende dich an deinen Administrator."),
      button("Erneut versuchen", () => flow.start(), true));
    return;
  }
  if (view.kind === "login") {
    content.append(element("h1", "Anmelden"),
      element("p", "Deine Zeiterfassung bei Anders Consulting."));
    const form = document.createElement("form");
    const email = input("email", "E-Mail-Adresse", "email", "username");
    email.field.value = view.email ?? "";
    email.field.placeholder = "name@andersconsulting.com";
    const password = input("password", "Passwort", "password", "current-password");
    password.field.placeholder = "Dein Passwort";
    const passwordWrap = element("div", "", "password-wrap");
    const reveal = element("button", "Anzeigen", "password-toggle") as HTMLButtonElement;
    reveal.type = "button";
    reveal.setAttribute("aria-label", "Passwort anzeigen");
    reveal.setAttribute("aria-controls", "password");
    reveal.setAttribute("aria-pressed", "false");
    reveal.addEventListener("click", () => {
      const visible = password.field.type === "password";
      password.field.type = visible ? "text" : "password";
      reveal.textContent = visible ? "Verbergen" : "Anzeigen";
      reveal.setAttribute("aria-label", visible ? "Passwort verbergen" : "Passwort anzeigen");
      reveal.setAttribute("aria-pressed", String(visible));
    });
    passwordWrap.append(password.field, reveal);
    const submit = element("button", "Anmelden →", "primary") as HTMLButtonElement;
    submit.type = "submit";
    if (view.message) {
      const message = element("p", view.message, "error");
      message.setAttribute("role", "alert");
      form.append(message);
    }
    form.append(email.label, email.field, password.label, passwordWrap, submit);
    form.addEventListener("submit", event => {
      event.preventDefault();
      const secret = password.field.value;
      password.field.value = "";
      void flow.login(email.field.value, secret);
    });
    content.append(form, element("p", "Noch kein Konto oder Passwort vergessen? Wende dich an deinen Administrator.", "hint"));
    return;
  }
  const identity = element("div", "", "identity");
  identity.append(element("strong", view.employee ?? "Timestone-Konto"), element("span", view.email));
  if (view.kind === "account") {
    content.append(element("h1", view.employee ? "Deine Zeit im Überblick." : "Mitarbeiterprofil fehlt"), identity);
    if (view.employee) renderReportForm();
    else content.append(element("p", "Dein Konto ist noch keinem Timestone-Mitarbeiter zugeordnet. Bitte deinen Administrator, die Zuordnung einzurichten."),
      element("p", `Kontokennung für deinen Administrator: ${view.userId}`, "hint identifier"));
  } else {
    content.append(element("h1", "Zugriff erlauben?"), element("p", `${view.client} möchte Timestone in deinem Namen verwenden.`), identity,
      element("p", "Der Assistent kann deine Arbeitszeiten, Krankmeldungen und Urlaube lesen und erfassen. Als Vorgesetzter kannst du zusätzlich die Anwesenheit deines direkten Teams auswerten. Es gelten deine bestehenden Timestone-Berechtigungen."));
    if (view.scopes.length) content.append(element("p", `Angefragte Profilfreigaben: ${view.scopes.join(", ")}`, "hint"));
    content.append(element("p", `Rückkehr zu: ${view.destination}`, "hint identifier"),
      button("Zugriff erlauben", () => flow.decide(true)), button("Ablehnen", () => flow.decide(false), true),
      element("p", "Die Verbindung kann den Zugriff im Hintergrund erneuern. Du kannst sie später in Copilot trennen.", "hint"));
  }
  content.append(button("Abmelden", () => flow.changeAccount(), true));
}

function input(id: string, text: string, type: string, autocomplete = "off") {
  const label = element("label", text) as HTMLLabelElement;
  label.htmlFor = id;
  const field = document.createElement("input");
  field.id = id;
  field.name = id;
  field.type = type;
  field.setAttribute("autocomplete", autocomplete);
  field.required = true;
  return { label, field };
}

function renderReportForm() {
  const form = document.createElement("form");
  const from = input("from", "Von", "date");
  const to = input("to", "Bis", "date");
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const today = ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
  from.field.value = today.slice(0, 8) + "01";
  to.field.value = today;
  const submit = element("button", "Meine Anwesenheiten anzeigen", "primary") as HTMLButtonElement;
  submit.type = "submit";
  const output = document.createElement("pre");
  output.className = "report";
  output.setAttribute("aria-live", "polite");
  const dates = element("div", "", "date-range");
  const start = element("div", "");
  const end = element("div", "");
  start.append(from.label, from.field);
  end.append(to.label, to.field);
  dates.append(start, end);
  form.append(dates, submit);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    submit.disabled = true;
    output.textContent = "Anwesenheiten werden geladen …";
    try {
      const { data, error } = await client.functions.invoke("get_my_attendance_list", { body: { from: from.field.value, to: to.field.value } });
      output.textContent = error || typeof data?.text !== "string"
        ? "Die Liste konnte nicht geladen werden. Prüfe den Zeitraum und melde dich gegebenenfalls erneut an."
        : data.text;
    } catch { output.textContent = "Verbindung fehlgeschlagen. Bitte erneut versuchen."; }
    finally { submit.disabled = false; }
  });
  content.append(form, output);
}

try {
  // A tab-scoped browser session is enough for login/consent. Copilot stores its own OAuth tokens.
  client = createClient(__SUPABASE_URL__, __SUPABASE_PUBLISHABLE_KEY__, { auth: {
    flowType: "pkce", detectSessionInUrl: false, persistSession: true, autoRefreshToken: true,
    storage: window.sessionStorage, storageKey: "timestone.auth",
  } });
  flow = createAuthFlow(client, {
    url: () => window.location.href,
    replace: url => window.history.replaceState(null, "", url),
    navigate: url => window.location.assign(url),
    storage: window.sessionStorage,
  }, render);
  void flow.start();
} catch {
  render({ kind: "error", message: "Die Anmeldung benötigt Browserspeicher. Bitte öffne die Verbindung in einem Browser, der Sitzungsspeicher erlaubt." });
}
