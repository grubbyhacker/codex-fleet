export function tuiProbe(): { ok: true; dashboard: "pending-opentui-phase" } {
  return { ok: true, dashboard: "pending-opentui-phase" };
}

if (process.argv.includes("--probe")) {
  console.log(JSON.stringify(tuiProbe()));
}
