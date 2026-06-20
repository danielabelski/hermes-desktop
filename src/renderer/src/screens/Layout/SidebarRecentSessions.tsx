import { useCallback, useEffect, useRef, useState, memo } from "react";
import { useI18n } from "../../components/useI18n";
import { Circle, Loader, Plus } from "../../assets/icons";

interface RecentSession {
  id: string;
  title: string;
}

// ChatGPT-style recent list under the Chat nav item.
export const RECENT_SESSIONS_LIMIT = 5;

// Re-sync cadence while the list is visible. Deliberately slower than the
// Sessions screen (30s) — the sidebar is always on screen, so this interval
// runs for the whole app lifetime when the section is expanded.
const RECENT_REFRESH_MS = 60_000;

// Minimum gap between event-driven refreshes (focus, session switch) so a
// burst of focus/blur events doesn't hammer state.db.
const REFRESH_THROTTLE_MS = 5_000;

function sameSessions(a: RecentSession[], b: RecentSession[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].title !== b[i].title) return false;
  }
  return true;
}

/**
 * Recent-sessions list rendered under the "Sessions" nav item in the sidebar
 * (like ChatGPT's sidebar chat list). Owns its own data so Layout re-renders
 * (view switches, update banners, …) never trigger fetches, and `memo` keeps
 * it off the render hot path entirely.
 *
 * Fetch strategy, cheapest first:
 *  - on open: instant read from the sessions.json cache (no DB), then one
 *    sync against state.db to pick up sessions created since the last sync
 *  - while open: refresh on window focus and on a slow interval, throttled
 *  - closed (collapsed section or icon-only sidebar): zero work, renders null
 */
const SidebarRecentSessions = memo(function SidebarRecentSessions({
  open,
  activeProfile,
  currentSessionId,
  loadingSessionIds,
  resumingSessionId,
  onSelect,
  onShowMore,
}: {
  open: boolean;
  /** Active profile — the list is per-profile, so switching forces a reload. */
  activeProfile: string;
  currentSessionId: string | null;
  /** Session ids of every run currently generating (multiple run at once). */
  loadingSessionIds: Set<string>;
  /** A session whose history is being fetched for resume (transient spinner). */
  resumingSessionId: string | null;
  onSelect: (sessionId: string) => void;
  /** Open the full-list sessions modal (shown via the "Show more" affordance
   *  when there are more sessions than the inline list holds). */
  onShowMore: () => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<RecentSession[]>([]);
  // True when the profile has more sessions than the inline list shows — drives
  // the "Show more" button that opens the full-list modal.
  const [hasMore, setHasMore] = useState(false);
  const lastRefreshRef = useRef(0);

  const applySessions = useCallback(
    (list: Array<{ id: string; title: string }>): void => {
      // `list` is fetched one over the display limit so we can tell whether a
      // "Show more" affordance is needed without a separate count query.
      setHasMore(list.length > RECENT_SESSIONS_LIMIT);
      const next = list
        .slice(0, RECENT_SESSIONS_LIMIT)
        .map(({ id, title }) => ({ id, title }));
      // Skip the state update (and re-render) when nothing changed — the
      // common case for periodic refreshes.
      setSessions((prev) => (sameSessions(prev, next) ? prev : next));
    },
    [],
  );

  const refresh = useCallback(
    async (force = false): Promise<void> => {
      const now = Date.now();
      if (!force && now - lastRefreshRef.current < REFRESH_THROTTLE_MS) return;
      lastRefreshRef.current = now;
      try {
        const synced = await window.hermesAPI.syncSessionCache();
        applySessions(synced);
      } catch {
        // keep whatever we had — the list is best-effort UI sugar
      }
    },
    [applySessions],
  );

  // Initial load when the section opens: paint from the JSON cache
  // immediately (no DB access), then sync once for anything new.
  // Sequenced so sync always wins over cache (avoids race where stale
  // cache overwrites fresh sync if sync resolves first).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const cached = await window.hermesAPI.listCachedSessions(
          // One over the display limit so the cache read alone can decide
          // whether to paint the "Show more" button.
          RECENT_SESSIONS_LIMIT + 1,
        );
        if (!cancelled && cached.length > 0) applySessions(cached);
      } catch {
        /* ignore cache read errors */
      }
      lastRefreshRef.current = Date.now();
      try {
        const synced = await window.hermesAPI.syncSessionCache();
        if (!cancelled) applySessions(synced);
      } catch {
        // cache read above already painted something
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, applySessions]);

  // While open: pick up background sessions (gateway, cron, other devices)
  // on focus and on a slow timer. No listeners or timers at all when closed.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => void refresh(), RECENT_REFRESH_MS);
    const onFocus = (): void => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [open, refresh]);

  // Resuming/switching sessions reorders recency — refresh (throttled).
  // Also refreshes when going to "New Chat" (currentSessionId becomes null)
  // so the just-left session appears in the list immediately.
  useEffect(() => {
    if (open) void refresh();
  }, [open, currentSessionId, refresh]);

  // Switching agent points the list at a different profile's DB. Force a
  // reload immediately (bypassing the throttle) so the list isn't stale.
  const prevProfileRef = useRef(activeProfile);
  useEffect(() => {
    if (prevProfileRef.current === activeProfile) return;
    prevProfileRef.current = activeProfile;
    void refresh(true);
  }, [activeProfile, refresh]);

  // Keep the wrapper mounted so the collapse/expand animates (CSS grid-rows
  // trick). Returning null would make it pop in/out. Effects above are still
  // gated on `open`, so a closed section does no fetching — it just keeps the
  // last-loaded list in the DOM to animate shut. Stay unmounted only until the
  // first sessions arrive, so a brand-new profile renders nothing.
  if (sessions.length === 0) return null;

  const expanded = open;

  return (
    <div
      className={`sidebar-recent-sessions-wrap ${expanded ? "expanded" : ""}`}
      aria-hidden={!expanded}
    >
      <div className="sidebar-recent-sessions">
        {sessions.map((s) => {
          const title = s.title || t("sessions.newConversation");
          const loading =
            resumingSessionId === s.id || loadingSessionIds.has(s.id);
          const active = !loading && currentSessionId === s.id;
          return (
            <button
              key={s.id}
              type="button"
              className={`sidebar-recent-session ${active ? "active" : ""}`}
              onClick={() => onSelect(s.id)}
              title={title}
              tabIndex={expanded ? 0 : -1}
            >
              {loading ? (
                <Loader
                  className="sidebar-recent-session-dot sidebar-recent-session-dot--loading"
                  size={11}
                />
              ) : (
                <Circle
                  className={`sidebar-recent-session-dot ${
                    active ? "sidebar-recent-session-dot--active" : ""
                  }`}
                  size={7}
                  fill={active ? "currentColor" : "none"}
                />
              )}
              <span className="sidebar-recent-session-title">{title}</span>
            </button>
          );
        })}
        {hasMore && (
          <button
            type="button"
            className="sidebar-recent-sessions-more"
            onClick={onShowMore}
            tabIndex={expanded ? 0 : -1}
          >
            <Plus className="sidebar-recent-sessions-more-icon" size={12} />
            <span>{t("navigation.showMore")}</span>
          </button>
        )}
      </div>
    </div>
  );
});

export default SidebarRecentSessions;
