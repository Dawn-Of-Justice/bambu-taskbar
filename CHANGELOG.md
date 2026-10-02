# Changelog

## 0.1.0

First version.

- Tray icon with the print's progress as a percentage, or a ring around a nozzle laying down filament, plus states for paused, finished, failed, idle
  and offline. Sharp at all display scalings and follows the taskbar's light/dark mode.
- Tooltip and menu with the file name, progress, layer, time left and finish time.
- Notifications: finished, almost done, paused, failed (with error code), and optionally started.
- Settings window with a live print card, printer discovery, connection status and notification settings.
- Two ways to connect, both read-only:
  - **Bambu Lab account** (default): sign in on Bambu Lab's own page in a window (Google, Apple or email), or
    with email and password in Settings plus an email code or authenticator code if Bambu asks for one. Global and China regions, and a printer picker. The printer stays in its normal mode.
    The password is never stored; the token is encrypted with Windows DPAPI.
  - **Local network**: MQTT over TLS to the printer, verified against Bambu Lab's CA and its serial number, with
    printer discovery. Needs LAN Only + Developer mode.
- Notification when the Bambu sign-in expires.
- Unit tests, including a fake TLS printer and a fake Bambu sign-in API.
