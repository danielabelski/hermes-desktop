# Main Process

The Electron main process keeps the entrypoint small and separates app lifecycle from IPC registration.

## Entrypoint

`src/main/index.ts` performs only pre-ready setup and delegates startup.

[[src/main/index.ts]] applies GPU crash preferences, enables the optional CDP testing port, and calls [[src/main/app/start.ts#startMainProcess]]. This keeps one-off process boot concerns separate from windows, menus, updater wiring, and IPC.

## GPU Fallback

Hardware acceleration is disabled and persisted after a GPU-process crash so machines without a usable GPU (VMs, virtual display adapters) avoid an infinite crash → relaunch loop.

[[src/main/gpu-fallback.ts#applyGpuPreferences]] disables hardware acceleration when a crash flag, relaunch sentinel, or `HERMES_DISABLE_GPU` says so, while keeping SwiftShader WebGL available. Persistent GPU-off fallback is honored by default on Windows/Linux, but macOS clears stale flags unless `HERMES_GPU_FALLBACK=1` forces it, protecting the Office tab from permanent software-rendering lag. [[src/main/gpu-fallback.ts#installGpuCrashGuard]] watches fatal GPU-process exits and relaunches with software rendering where the persistent fallback is enabled.

## App Lifecycle

Lifecycle code owns Electron windows, global app events, and shutdown cleanup.

[[src/main/app/start.ts#startMainProcess]] registers crash logging, IPC handlers, updater handlers, Electron ready/activate/window-all-closed/before-quit events, CSP headers, security hardening, and the main BrowserWindow.

[[src/main/app/start.ts]] also supports the `HERMES_OPEN_DEVTOOLS=1` diagnostic launch path so packaged builds can expose renderer console errors when startup fails before the UI paints.

The packaged renderer keeps its meta CSP aligned with the production response CSP so file-backed startup assets load consistently from `file://` before the main-process header can help.

Because electron-vite emits a bundled main file at `out/main/index.js`, packaged renderer loading resolves `../renderer/index.html` from `__dirname` to reach `out/renderer/index.html`.

## App Chrome Helpers

Menu, updater, and context-menu behavior live in focused modules.

[[src/main/app/menu.ts#buildMenu]] owns the application menu, [[src/main/app/updater.ts#setupUpdater]] owns update IPC and electron-updater events, and [[src/main/app/context-menu.ts#showChatContextMenu]] owns the chat right-click menu.

Release builds keep a Help-menu Developer Tools toggle as a production diagnostics escape hatch without changing renderer sandbox or Node isolation.

## IPC Registry

Renderer IPC handlers are isolated from app bootstrap so the registry can be split by domain.

[[src/main/ipc/register.ts#registerIpcHandlers]] currently preserves the existing handler behavior behind one registration function. It receives app-level callbacks for the main window, model-library notifications, connection-config notifications, external URL opening, and active chat abort handles.
