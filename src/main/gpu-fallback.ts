import { app } from "electron";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

// One-shot command-line sentinel carried across an automatic relaunch. It lets
// the relaunched process start with GPU disabled even when the flag file could
// not be written (read-only FS, permissions) — which is what breaks the
// otherwise-infinite crash → relaunch cycle (PR #605 review).
const GPU_DISABLE_ARG = "--hermes-gpu-disabled";

/** Normalised HERMES_DISABLE_GPU: "on" to force-disable, "off" to force-enable
 *  (overriding a persisted flag), or null when unset/unrecognised. */
function gpuEnvOverride(): "on" | "off" | null {
  const v = (process.env.HERMES_DISABLE_GPU || "").trim().toLowerCase();
  if (v === "1" || v === "true") return "on";
  if (v === "0" || v === "false") return "off";
  return null;
}

// Some machines — notably Windows boxes running remote-control software that
// installs virtual display adapters (Todesk, GameViewer/向日葵, TeamViewer,
// Sunlogin, etc.) — confuse Chromium's GPU initialization. The GPU process
// crashes on launch, Chromium retries ~9 times and then fatally exits with
// "GPU process isn't usable. Goodbye." (issue #592).
//
// Passing --disable-gpu on the external command line doesn't reliably help
// because the GPU process still attempts to initialize. The robust fix is to
// disable hardware acceleration from inside the main process *before* the app
// is ready, and to remember that choice across launches once we've seen the
// GPU process die.

// Resolve the flag path once, at module load — before app.setName() runs in
// whenReady — so the path the crash guard writes to is the same one we read
// from on the next launch (app.getPath("userData") depends on app.name).
let cachedFlagPath: string | null = null;

function flagPath(): string {
  if (!cachedFlagPath) {
    cachedFlagPath = join(app.getPath("userData"), "disable-gpu.flag");
  }
  return cachedFlagPath;
}

/**
 * True when hardware acceleration should be disabled. Precedence:
 *   1. HERMES_DISABLE_GPU=0/false — force-enable, overrides everything else.
 *   2. HERMES_DISABLE_GPU=1/true  — force-disable.
 *   3. the relaunch sentinel arg  — a prior crash relaunched us GPU-off.
 *   4. the persisted disable-gpu.flag from a previous crash.
 */
export function isGpuDisabled(): boolean {
  const env = gpuEnvOverride();
  if (env === "off") return false;
  if (env === "on") return true;
  if (process.argv.includes(GPU_DISABLE_ARG)) return true;
  try {
    return existsSync(flagPath());
  } catch {
    return false;
  }
}

/** Remove the persisted disable-gpu flag, if present. Best-effort. */
function clearGpuFlag(): void {
  try {
    if (existsSync(flagPath())) {
      rmSync(flagPath(), { force: true });
      console.warn(
        "[GPU] HERMES_DISABLE_GPU override — cleared persisted disable-gpu.flag; " +
          "hardware acceleration re-enabled.",
      );
    }
  } catch (err) {
    console.error("[GPU] Failed to clear disable-gpu flag:", err);
  }
}

/**
 * Apply GPU-disabling switches. MUST be called before app is ready (i.e. at
 * module load, before app.whenReady()), otherwise app.disableHardwareAcceleration()
 * throws and the command-line switches are ignored.
 */
export function applyGpuPreferences(): void {
  // An explicit force-enable should also wipe any persisted flag so the
  // choice sticks on future launches, not just this one.
  if (gpuEnvOverride() === "off") clearGpuFlag();
  if (!isGpuDisabled()) return;
  console.warn(
    "[GPU] Hardware acceleration disabled (software rendering). " +
      "Set HERMES_DISABLE_GPU=0 or delete the disable-gpu.flag file to re-enable.",
  );
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  // Keep the software (SwiftShader) rasterizer available so WebGL surfaces — the
  // Office 3D tab — still render when hardware acceleration is off (VMs, headless
  // GPUs, machines whose GPU process crashes). We deliberately do NOT pass
  // --disable-software-rasterizer. Chromium 136 gates SwiftShader-backed WebGL
  // behind --enable-unsafe-swiftshader, so opt in explicitly; without it WebGL
  // context creation fails ("Could not create a WebGL context ... Disabled").
  app.commandLine.appendSwitch("enable-unsafe-swiftshader");
}

/** Persist the disable-gpu flag. Returns false if the write failed so the
 *  caller can fall back to the relaunch sentinel and avoid a crash loop. */
function persistGpuDisabled(): boolean {
  try {
    const dir = app.getPath("userData");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(flagPath(), new Date().toISOString(), "utf-8");
    return true;
  } catch (err) {
    console.error("[GPU] Failed to persist disable-gpu flag:", err);
    return false;
  }
}

/**
 * Watch for fatal GPU process crashes. When the GPU process dies abnormally
 * (the symptom on machines with virtual display adapters), persist the
 * disable-gpu flag and relaunch the app with software rendering instead of
 * letting Chromium retry-then-fatally-exit. Only acts once per launch.
 *
 * Register this early (before app is ready); the event itself fires later.
 */
export function installGpuCrashGuard(): void {
  // Already running with GPU disabled — nothing left to guard against.
  if (isGpuDisabled()) return;

  let recovering = false;
  app.on("child-process-gone", (_event, details) => {
    if (details.type !== "GPU") return;
    // A clean exit isn't a crash — ignore it.
    if (details.reason === "clean-exit") return;
    if (recovering) return;
    recovering = true;

    console.error(
      `[GPU] GPU process gone (reason=${details.reason}, exitCode=${details.exitCode}). ` +
        "Disabling hardware acceleration and relaunching with software rendering.",
    );
    const persisted = persistGpuDisabled();
    if (!persisted) {
      console.error(
        "[GPU] Could not persist disable-gpu.flag (read-only/locked filesystem?). " +
          "Relaunching with a one-shot switch; hardware acceleration may need to be " +
          "disabled manually via HERMES_DISABLE_GPU=1 if this recurs.",
      );
    }
    // Carry the sentinel arg so the relaunched process starts GPU-off even if
    // the flag write failed — this is what prevents an infinite crash loop.
    const args = process.argv
      .slice(1)
      .filter((a) => a !== GPU_DISABLE_ARG)
      .concat(GPU_DISABLE_ARG);
    app.relaunch({ args });
    app.exit(0);
  });
}
