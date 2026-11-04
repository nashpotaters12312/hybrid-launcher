# Hybrid Launcher

One launcher for every game on your Windows PC: Steam, Epic Games, and any game's `.exe` or shortcut.

## Features

- **Finds your games automatically.** Click *Scan for games* to pick up installed Steam games (wherever Steam is installed, across all its library folders) and Epic Games titles.
- **Add anything else.** Browse to an `.exe`, `.lnk` or `.url`, drag a file onto the window, or paste a launcher link such as `steam://rungameid/570`.
- **Cover art.** Steam games get their artwork automatically. For other games, use an image URL or pick a file. Games with no artwork show their icon on a colored tile.
- **Epic games start directly** from their own `.exe`, without opening the Epic Games Launcher. Some Epic games require the launcher for sign-in or DRM; those may still open it themselves.
- **Tracks play time** for games launched from an `.exe` (including Epic games), and shows when you last played each game.
- **Organize your library** with favorites, a *Continue playing* row, search (Ctrl+F or `/`), sorting, filtering by source, and hiding games.
- **Launch options** for each game, e.g. `-windowed -novid`.
- An option to minimize the launcher when a game starts.

## Install

1. Open the **Actions** tab on GitHub, pick the latest successful **Build Windows installer** run, and download the **Hybrid-Launcher-Setup** artifact.
   - Or push a tag such as `v1.0.0`; the installer is then attached to a GitHub Release.
2. Unzip it and run `Hybrid-Launcher-Setup-1.0.2.exe`.
3. The installer isn't code-signed, so Windows SmartScreen may warn you. Click **More info → Run anyway**.

The installer adds Start Menu and desktop shortcuts and can be uninstalled from *Settings → Apps*.

Your library is stored in `%APPDATA%\Hybrid Launcher\library.json`.

## Develop

```bash
npm install
npm start        # run the app
npm run dist     # build the Windows installer into dist/ (run on Windows)
```
