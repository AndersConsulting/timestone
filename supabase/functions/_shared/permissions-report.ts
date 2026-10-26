export type PermissionsReport = {
  role: "User" | "Manager" | "Admin";
  permissions: { code: string; label: string }[];
  notes: string[];
};

/** Only backend-confirmed capabilities are displayed; no role is inferred by AI. */
export function formatPermissions(report: PermissionsReport): string {
  if (!report || !["User", "Manager", "Admin"].includes(report.role) || !Array.isArray(report.permissions) || !Array.isArray(report.notes)) {
    throw new Error("Ungueltige Berechtigungsantwort.");
  }
  const lines = [
    "TIMESTONE | BERECHTIGUNGEN", "", `Du bist: ${report.role}`, "", "Du darfst:",
    ...report.permissions.map(p => `- ${p.label}`), "", "Hinweise:", ...report.notes.map(note => `- ${note}`),
  ];
  const width = Math.max(...lines.map(line => line.length));
  const border = "+" + "-".repeat(width + 2) + "+";
  return [border, ...lines.map(line => `| ${line.padEnd(width)} |`), border].join("\n");
}
