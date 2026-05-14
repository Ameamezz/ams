# AmiyaPlayer Upgrade Tasks

## 1. Upgrade Goal

AmiyaPlayer should evolve from a simple Bilibili overlay toolbar into a lightweight floating web player/browser.

The core identity should stay focused:

- Floating, always-on-top web/video window
- Transparent and click-through playback mode
- Persistent login state for frequently used websites
- Fast access to history, favorites, and common playback controls
- Customizable toolbar buttons and shortcuts

This project should not become a full browser. It should remain a compact companion window for video, web pages, and daily pinned sites.

## 2. Target Product Shape

Main window layout:

```text
+----------------------------------------------------------------+
| Title / Address Bar / Toolbar                  Pin  Settings _ X |
+------------------+---------------------------------------------+
| Sidebar          |                                             |
| - Tabs           |                                             |
| - History        |              Current Webview                |
| - Favorites      |                                             |
| - Recent         |                                             |
+------------------+---------------------------------------------+
```

Supported modes:

- Normal mode: top bar + sidebar + webview
- Playback mode: top bar + webview, sidebar hidden
- Clean mode: webview only, minimal UI
- Click-through mode: mouse passes through window, UI hidden or disabled

## 3. Phase 1 - Window Shell

Goal: turn the current toolbar into a proper application window.

Tasks:

- Add a custom top title bar.
- Add window controls:
  - Minimize
  - Close
  - Optional maximize/restore
- Add toolbar actions:
  - Back
  - Forward
  - Refresh
  - Home or start page
  - Always on top toggle
  - Click-through toggle
  - Settings
- Keep the address input and play/open button.
- Make the top bar draggable except for controls and inputs.
- Add clear visual states for:
  - Always on top enabled
  - Click-through enabled
  - Page loading
  - Page load error

Acceptance criteria:

- User can close and minimize the app from the UI.
- User can still drag the frameless window.
- Existing Bilibili playback flow still works.
- Current shortcuts still work.
- Top bar remains readable at 800px width.

## 4. Phase 2 - Sidebar, Tabs, History, Favorites

Goal: add basic lightweight browser organization.

Tasks:

- Add a collapsible left sidebar.
- Add sidebar sections:
  - Tabs
  - History
  - Favorites
  - Recent links
- Add current-tab list.
- Add favorite current page action.
- Add remove favorite action.
- Add open favorite/history item action.
- Automatically record visited URLs.
- Store page title when available.
- Add simple search/filter for history and favorites.

Suggested JSON files:

```text
settings.json
tabs.json
history.json
favorites.json
```

Suggested favorite item:

```json
{
  "id": "uuid",
  "title": "Bilibili",
  "url": "https://www.bilibili.com",
  "createdAt": "2026-05-14T00:00:00.000Z",
  "updatedAt": "2026-05-14T00:00:00.000Z"
}
```

Suggested history item:

```json
{
  "id": "uuid",
  "title": "Video Title",
  "url": "https://www.bilibili.com/video/...",
  "visitedAt": "2026-05-14T00:00:00.000Z"
}
```

Acceptance criteria:

- User can open multiple saved links from the sidebar.
- User can favorite the current page.
- User can reopen a recent/history page.
- Sidebar can be hidden for playback.
- History avoids excessive duplicate spam from the same URL.

## 5. Phase 3 - Persistent Login State

Goal: logged-in websites should stay logged in after restart.

Tasks:

- Continue using a persistent Electron partition:

```text
persist:amiyaplayer
```

- Ensure every webview uses the same persistent partition unless explicitly configured otherwise.
- Flush storage and cookies on quit.
- Add settings actions:
  - Clear current site's data
  - Clear all web data
  - Open user data folder
- Do not store account passwords manually.
- Let Electron/Chromium manage cookies, localStorage, IndexedDB, and cache.

Acceptance criteria:

- User logs into Bilibili, closes app, reopens app, and remains logged in.
- User can clear login state from settings.
- Clearing all web data logs the user out from stored websites.

## 6. Phase 4 - Settings Panel

Goal: centralize user customization.

Recommended form: right-side drawer or modal window.

Settings sections:

- Appearance
  - Opacity
  - Theme color
  - Sidebar width
  - Show/hide top bar in playback mode
- Toolbar
  - Show/hide buttons
  - Reorder buttons
  - Rename button labels
  - Choose icon/color
- Shortcuts
  - Global shortcuts
  - Toolbar action shortcuts
  - Reset shortcut defaults
- Web data
  - Clear current site data
  - Clear all site data
  - Open user data folder
- Startup
  - Restore last tabs
  - Open last URL
  - Open favorites/home page

Acceptance criteria:

- Settings persist after app restart.
- Reset defaults works.
- Invalid shortcut conflicts are detected and explained.
- Toolbar changes are reflected immediately.

## 7. Phase 5 - Custom Toolbar Buttons

Goal: let users customize visible controls without editing code.

Built-in action types:

- Open URL
- Back
- Forward
- Refresh
- Toggle always on top
- Toggle click-through
- Toggle sidebar
- Toggle clean mode
- Toggle Bilibili focus/select mode
- Play/pause
- Rewind
- Forward video
- Decrease opacity
- Increase opacity
- Favorite current page
- Open settings

Suggested button config:

```json
{
  "id": "play-pause",
  "type": "builtin",
  "action": "video.togglePlay",
  "label": "Play",
  "icon": "play",
  "visible": true,
  "shortcut": "F9",
  "order": 10
}
```

Acceptance criteria:

- User can hide, show, and reorder toolbar buttons.
- User can change a button label.
- User can restore default toolbar layout.
- Existing keyboard controls remain compatible.

## 8. Phase 6 - Playback Enhancements

Goal: improve the original Bilibili overlay use case.

Tasks:

- Keep Bilibili focus mode.
- Keep Bilibili select/playlist mode.
- Add automatic retry for CSS injection after navigation.
- Add visible fallback if Bilibili layout injection fails.
- Add site-specific rules structure so future pages can be supported.

Possible site rule shape:

```json
{
  "id": "bilibili",
  "match": ["https://www.bilibili.com/video/*"],
  "modes": {
    "focus": "...css...",
    "select": "...css..."
  }
}
```

Acceptance criteria:

- Bilibili video page still enters clean playback mode.
- Select/playlist mode still exposes episode list.
- UI does not break if page structure changes; it should fail gracefully.

## 9. Data And Storage Rules

Use JSON first. Move to SQLite only if history and tabs become large or slow.

Recommended storage location:

```text
app.getPath('userData')
```

Recommended files:

- `settings.json`
- `tabs.json`
- `history.json`
- `favorites.json`

Rules:

- Write files atomically where possible.
- Validate loaded JSON and fall back to defaults.
- Keep backward compatibility when settings schema changes.
- Never crash the app because one settings file is malformed.

## 10. Security Notes

Important Electron settings should be reviewed during implementation:

- Avoid enabling Node integration inside untrusted web content.
- Prefer a preload bridge for app UI actions.
- Keep external websites inside webview only.
- Deny unexpected popup windows unless explicitly handled.
- Do not manually store user passwords or tokens.
- Confirm before clearing all web data.

Current project uses `nodeIntegration: true` and `contextIsolation: false`. This is acceptable for the first prototype, but should be improved during the window-shell refactor.

## 11. Suggested Implementation Order

1. Split app UI into clearer sections inside `index.html`.
2. Add title bar controls and IPC handlers in `main.js`.
3. Add a small storage helper for settings/history/favorites.
4. Add sidebar UI and basic favorites/history.
5. Add settings panel.
6. Add toolbar customization.
7. Harden webview security and persistent session handling.
8. Polish visual design and edge states.

## 12. Nice-To-Have Ideas

- Import/export settings and favorites.
- Per-site opacity and click-through preferences.
- Quick command palette.
- Tray icon with show/hide controls.
- Boss key: instantly hide/show window.
- Screenshot current webview.
- Picture-in-picture style compact mode.
- Auto-hide top bar while mouse is away.
- Pin favorite websites to sidebar.

## 13. Definition Of Done For The Upgrade

The upgrade can be considered complete when:

- The app feels like a real compact window, not only a toolbar.
- Login state survives restart.
- History and favorites are usable from the sidebar.
- Toolbar buttons can be customized from settings.
- Bilibili playback mode remains at least as good as the current version.
- Settings and user data survive app restart.
- App can be packaged into a portable EXE successfully.
