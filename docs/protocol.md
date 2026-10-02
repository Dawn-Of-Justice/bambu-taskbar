# Printer protocol notes

How bambu-taskbar talks to a Bambu Lab printer, through Bambu's cloud or directly over the LAN. Based on the
community documentation at [Doridian/OpenBambuAPI](https://github.com/Doridian/OpenBambuAPI) and checked against the app's tests.

## Account (cloud) mode

### Sign-in (`src/main/cloud/cloud_auth.ts`)

Requests go through Electron's Chromium network stack (`electron_http.ts`) in a private session, with a plain
Chrome user agent, because the API sits behind Cloudflare.

1. `POST https://api.bambulab.com/v1/user-service/user/login` `{account, password}` returns one of:
   - `accessToken` (and `expiresIn`, about 90 days): signed in.
   - `loginType: "verifyCode"`: `POST /v1/user-service/user/sendemail/code` `{email, type: "codeLogin"}`, then
     log in again with `{account, code}`. Error `code: 1` means the code expired (a new one is sent); `code: 2`
     means it was wrong.
   - `loginType: "tfa"` + `tfaKey`: `GET https://bambulab.com/api/csrf` (sets `bbl_csrf_token`), then
     `POST https://bambulab.com/api/sign-in/tfa` `{tfaKey, tfaCode}` with header `x-bbl-csrf-token`. The token
     comes back as the `token` cookie.
2. The MQTT username is `u_<uid>`: from the token's JWT payload (`username`), or from
   `GET /v1/design-user-service/my/preference` (`uid`).
3. Printers: `GET /v1/iot-service/api/user/bind` returns `devices[]` with `dev_id` (serial), `name`, `online` and
   `dev_product_name`.

**Website sign-in (Google, Apple, email):** `browser_signin.ts` opens `https://bambulab.com/en/sign-in` in a window
with its own in-memory session (Chrome user agent, Google/Apple popups kept in the same session, other links sent
to the default browser). Once the user is signed in the site sets a `token` cookie on `bambulab.com`; the app reads
it, closes the window, and continues at step 2 with that token. The account email comes from
`GET /v1/user-service/my/profile` when available.

The China region uses `.cn` hosts (`api.bambulab.cn`, `bambulab.cn`, `cn.mqtt.bambulab.com`). The refresh-token
endpoint no longer works, so users sign in again when the token expires. The password is only sent to Bambu and
never stored. The token is stored encrypted with DPAPI.

### MQTT

| | |
|---|---|
| Broker | `us.mqtt.bambulab.com:8883` (China: `cn.mqtt.bambulab.com`), TLS with the system's trusted CAs |
| Username | `u_<uid>` |
| Password | the access token |
| Topics | same as LAN: `device/<serial>/report`, `device/<serial>/request` |

A CONNACK refusal (code 4 or 5) means the token expired: the app shows "sign in again" and sends one
notification. If the broker accepts the connection but no report arrives within 20 seconds, the printer is
probably off.

Bambu's 2025 authorization firmware still allows third-party apps to read status ("MQTT status push for tools
like HomeAssistant"); control commands need Bambu's own software.

## Local network (LAN) mode

| | |
|---|---|
| Transport | MQTT 3.1.1 over TLS, port **8883** |
| Username | `bblp` |
| Password | the LAN **access code** shown on the printer |
| Status topic | `device/<serial>/report` (subscribe) |
| Command topic | `device/<serial>/request` (publish) |

**TLS:** the printer's certificate is issued by Bambu Lab's own CA (`assets/bambu-ca.pem`, several "BBL CA"
certificates) and its common name is the printer's **serial number**, not its IP address. The app connects with
`servername = serial`, trusts only the bundled CA, and checks the CN itself (`checkPrinterIdentity`). A wrong
serial number therefore shows as a certificate error. **Allow unverified certificate** in Settings turns off both
checks; the connection stays encrypted.

**Errors** (`classifyError`):

| What happens | Shown as | Retries? |
|---|---|---|
| CONNACK code 4 or 5 (bad user/password, not authorised) | Access code rejected | No, waits for a new code |
| TLS verification or CN mismatch | Certificate error | No |
| Refused, unreachable, timeout | Offline | Yes, every 5 s |

## Requesting a full report

Right after subscribing, and then every 10 minutes, the app publishes:

```json
{ "pushing": { "sequence_id": "0", "command": "pushall", "version": 1, "push_target": 1 } }
```

X1 printers send their full status in every report. P1 and A1 printers send only the fields that changed, so
without `pushall` the app would not know the file name or totals until they change. The community docs advise
against sending `pushall` to a P1P more often than every 5 minutes.

## Status report fields used

Reports look like `{ "print": { "command": "push_status", ... } }`. Replies to commands also arrive under `print`
with a different `command`, and are ignored. Numbers may arrive as strings.

| Field | Used for |
|---|---|
| `gcode_state` | `IDLE` → idle, `PREPARE`/`SLICING`/`INIT` → preparing, `RUNNING` → printing, `PAUSE` → paused, `FINISH` → finished, `FAILED` → failed |
| `mc_percent` | Progress 0–100. Shown as at most 99 until the state is `FINISH` |
| `mc_remaining_time` | Minutes left, and the "done at" clock time |
| `layer_num`, `total_layer_num` | Layer x / y |
| `subtask_name` | File name. Falls back to the base name of `gcode_file` |
| `stg_cur` | Current stage, e.g. 2 = heating the bed, 6 = paused because filament ran out. See `printer_info.ts` |
| `nozzle_temper`, `nozzle_target_temper`, `bed_temper`, `bed_target_temper` | Temperatures in the settings window |
| `print_error` | Error code in the "Print failed" notification, formatted like the printer (`0300-400C`) |

## Discovery

Printers broadcast SSDP-style `NOTIFY` messages on UDP **2021** and **1990** every few seconds:

```
NOTIFY * HTTP/1.1
Location: 192.168.1.42
NT: urn:bambulab-com:device:3dprinter:1
USN: 01S00A000000001
DevModel.bambu.com: C12
DevName.bambu.com: Workshop P1S
DevConnect.bambu.com: lan
```

The app listens on both ports for 6 seconds and also sends an `M-SEARCH`, which makes some printers answer
straight away. `USN` is the serial number and `DevModel` the model code (C12 = P1S, see `printer_info.ts`).
`DevConnect` shows whether the printer is in LAN mode.
