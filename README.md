# Hybrid Launcher

One launcher for every game on your Windows PC: Steam, Epic Games, and any game's `.exe` or shortcut.

## Features

- **Finds your games automatically.** Click *Scan for games* to pick up installed Steam games (wherever Steam is installed, across all its library folders) and Epic Games titles.
- **Add anything else.** Browse to an `.exe`, `.lnk` or `.url`, drag a file onto the window, or paste a launcher link such as `steam://rungameid/570`.
- **Automatic cover art.** Every game gets a cover automatically, found by name in Steam's store and saved locally so it works offline. For games that aren't on Steam, add a free [SteamGridDB](https://www.steamgriddb.com) API key in *Settings*. You can also use **Find cover** on any game, or pick your own image with *Edit*.
- **Epic games start directly** from their own `.exe`, without opening the Epic Games Launcher. Some Epic games require the launcher for sign-in or DRM; those may still open it themselves.
- **Tracks play time** for games launched from an `.exe` (including Epic games), and shows when you last played each game.
- **Pick for me.** Can't decide? Click *Pick for me* and a game is chosen from your library, favouring ones you haven't played in a while, have never played, or love. Choose *Surprise me*, *Never played*, *Haven't played in a while* or *A favorite*. Add an Anthropic API key in *Settings* and Claude picks based on your mood ("something chill for 30 minutes") and tells you why. When you use the AI picker, your game names and play history are sent to Anthropic.
- **Right-click any game** to play it, favorite it, add it to a collection, edit it, find a cover, open its folder, make a desktop shortcut, hide or remove it.
- **Collections** like "Co-op" or "Backlog" in the sidebar (right-click one to rename or delete it), plus **notes** for each game.
- **Grid or list view**, a **Stats** page (play time per day, most played, library by store), and a **light theme**.
- **System tray icon** with your recent games and *Pick for me*; optionally close to the tray.
- **Desktop shortcuts** for any game that start it through the launcher, so play time is still tracked.
- **Keyboard friendly:** arrow keys move between games, Enter plays, Space opens details, F favorites, the Menu key opens the right-click menu.
- **Arcade:** three quick original mini games for when you can't decide: *Cover Match* (a memory game made from your own covers), *Orbit Dodge* (circle the core and dodge debris) and *Quick Draw* (a reaction test). Best scores are saved, and every round ends with a button to pick a real game.
- **Organize your library** with favorites, a *Continue playing* row, search (Ctrl+F or `/`), sorting, filtering by source, and hiding games.
- **Launch options** for each game, e.g. `-windowed -novid`.
- **Settings:** start with Windows (optionally minimized), minimize while playing, automatically add newly installed games, accent color, cover size, show or hide *Continue playing*, animations on or off, and back up or restore your library.
- **Smooth:** cards are reused rather than redrawn, so covers never flicker; panels and dialogs animate; the app remembers its window size and position and your last filter and sort.

## Install

1. Open the repository's **Releases** page on GitHub and download the latest `Hybrid-Launcher-Setup-<version>.exe`.
2. Run it. The installer isn't code-signed, so Windows SmartScreen may warn you: click **More info → Run anyway**.

The installer adds Start Menu and desktop shortcuts and can be uninstalled from *Settings → Apps*.

### Updates

The app checks for new versions on startup and every few hours, downloads them in the background, and shows an **Update** button in the sidebar. Click it to restart into the new version (or it installs the next time you quit). You can also use *Settings → Updates → Check for updates*, and turn off automatic downloads there.

Each push that changes the version in `package.json` is built and published as a GitHub Release by the *Build Windows installer* workflow, which is what installed copies update from.

Your library is stored in `%APPDATA%\Hybrid Launcher\library.json`.

## Develop

```bash
npm install
npm start        # run the app
npm run dist     # build the Windows installer into dist/ (run on Windows)
```
