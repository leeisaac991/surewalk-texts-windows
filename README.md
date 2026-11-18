# SURE Walk Texts – Windows

Runs the SURE Walk texting server and the UT iPhone Bluetooth bridge on a Windows laptop, with **no install and no admin rights**.

## Get it on the laptop

1. Click **Code ▸ Download ZIP** and extract it anywhere (Documents is fine).
2. Pair the iPhone in **Settings ▸ Bluetooth & devices**. On the iPhone, go to **Settings ▸ Bluetooth ▸ (i)** next to the laptop and turn on **Show Notifications**.
3. **Only one computer may run texting at a time.** Stop texting on the other dispatch PC first.
4. Double-click **`START-TEXTING.cmd`**. The dashboard opens at http://127.0.0.1:8787. The first time, click the GroupMe pill and pick the sync chat (the same one the Excel texts panel uses). Auto-text starts off.

| File | What it does |
|---|---|
| `START-TEXTING.cmd` | Starts the texting server and phone bridge, then opens the dashboard |
| `STOP-TEXTING.cmd` | Stops both |
| `START-AT-LOGIN.cmd` | Turns starting at login on or off (uses your own Startup folder) |
| `TEST-BRIDGE.cmd` | Tests the bridge against a pretend iPhone and a throwaway server; safe any time |

## How it works

- **`app/texts-panel/server`**: the texting server (Node.js). It runs the Apps Script texting code in `app/apps-script` locally. It uses the portable Node.js in the included official `node-v*-win-x64.zip` from nodejs.org, which gets unpacked into `%LOCALAPPDATA%\surewalk-texts` on first start.
- **`app/windows/bridge.ps1`**: the phone bridge (Windows PowerShell 5.1, built in). It talks to the paired iPhone over Bluetooth using the Message Access Profile, through Windows' own Bluetooth APIs. It forwards new texts to the server and sends the texts the server queues.
- **Data stays on the laptop.** Settings, the message log and server.log go in `%LOCALAPPDATA%\surewalk-texts`. Bridge state and bridge.log go in `%LOCALAPPDATA%\surewalk-bridge`; that log has no message text or phone numbers. Nothing in this repo holds keys, tokens or message data.
- **Not supported on Windows:** the dashboard's call button. Call from the iPhone instead.

This repo is built from the `windows/` folder of [surewalk-texts](https://github.com/leeisaac991/surewalk-texts) with `windows/pack.sh`.
