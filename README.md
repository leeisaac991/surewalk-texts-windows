# SURE Walk Texts – Windows

Runs the SURE Walk texting server and the UT iPhone Bluetooth bridge on a Windows laptop, with **no install and no admin rights**.

## Get it on the laptop

1. Download **SURE-Walk-Texts-Windows.zip** from the [latest release](https://github.com/leeisaac991/surewalk-texts-windows/releases/latest) and extract it.
2. Double-click **`INSTALL.cmd`**. It installs for you only (no admin) into `%LOCALAPPDATA%\Programs\SURE Walk Texts` and adds Start menu shortcuts. After that you can delete the downloaded folder. You can also skip installing and run everything straight from the folder.
3. Pair the iPhone in **Settings ▸ Bluetooth & devices**. On the iPhone, go to **Settings ▸ Bluetooth ▸ (i)** next to the laptop and turn on **Show Notifications**.
4. **Only one computer may run texting at a time.** Stop texting on the other dispatch PC first.
5. Start menu ▸ **SURE Walk Texts**. The dashboard opens at http://127.0.0.1:8787. The first time, click the GroupMe pill and pick the sync chat (the same one the Excel texts panel uses). Auto-text starts off.

| Start menu / file | What it does |
|---|---|
| SURE Walk Texts (`START-TEXTING.cmd`) | Starts the texting server and phone bridge, then opens the dashboard |
| Stop SURE Walk Texts (`STOP-TEXTING.cmd`) | Stops both |
| Check for updates (`UPDATE.cmd`) | Installs the newest release, keeping your settings and message log |
| Test a call (`TEST-CALL.cmd`) | Has the iPhone dial a number you type |
| Test the phone bridge (`TEST-BRIDGE.cmd`) | Tests the bridge against a pretend iPhone and a throwaway server; safe any time |
| Start at login (`START-AT-LOGIN.cmd`) | Turns starting at login on or off |
| Uninstall | Removes the app and its shortcuts, and asks before deleting any data |

## Updates

Each version is a numbered **release** here (for example `v2026.11.18`), with the zip and its SHA-256 checksum. When the app starts, it checks for a newer release and asks in a popup. No answer within 30 seconds means "not now", and it never updates on its own. Updating downloads the release, checks the checksum, swaps in the new code and restarts texting. Your settings, GroupMe setup and message log stay as they are.

## Calls

The dashboard's **Call** button makes the iPhone dial the rider, the way a car's hands-free system does. The bridge lets go as soon as the iPhone starts dialing, so the call and its audio stay on the iPhone; pick it up there. The bridge can't hang up or tell when the rider answers.

## How it works

- **`app/texts-panel/server`**: the texting server (Node.js). It runs the Apps Script texting code in `app/apps-script` locally. It uses the portable Node.js in the included official `node-v*-win-x64.zip` from nodejs.org, which gets unpacked into `%LOCALAPPDATA%\surewalk-texts` on first start.
- **`app/windows/bridge.ps1`**: the phone bridge (Windows PowerShell 5.1, built in). It talks to the paired iPhone over Bluetooth using the Message Access Profile, through Windows' own Bluetooth APIs. It forwards new texts to the server and sends the texts the server queues.
- **Data stays on the laptop.** Settings, the message log and server.log go in `%LOCALAPPDATA%\surewalk-texts`. Bridge state and bridge.log go in `%LOCALAPPDATA%\surewalk-bridge`; that log has no message text or phone numbers. Nothing in this repo holds keys, tokens or message data.

This repo is built from the `windows/` folder of [surewalk-texts](https://github.com/leeisaac991/surewalk-texts) with `windows/pack.sh`.
