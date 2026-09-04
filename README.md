<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/banner.svg">
  <source media="(prefers-color-scheme: light)" srcset="./docs/assets/banner.svg">
  <img alt="Epic-Fab — Best of both — Epic Games library + Linux-native CLI." src="./docs/assets/banner.svg" width="900">
</picture>

<br/>

[![Typing SVG](https://readme-typing-svg.demolab.com?font=JetBrains+Mono&weight=600&size=22&pause=1100&color=58A6FF&center=true&vCenter=true&width=700&lines=Your%20Epic%20library%2C%20on%20Linux.;No%20launcher.%20No%20Wine.%20No%20compromises.;Browse.%20Download.%20Sync.%20Done.;MIT%20licensed.%20Bun%20%2B%20TypeScript.%20Forever%20yours.)](https://github.com/StarksLabs/epic-fab)

<br/>

<!-- Project Health -->
[![License](https://img.shields.io/github/license/StarksLabs/epic-fab?style=flat&color=f0883e)](https://github.com/StarksLabs/epic-fab/blob/master/LICENSE)
[![Last Commit](https://img.shields.io/github/last-commit/StarksLabs/epic-fab?style=flat&logo=github&color=58a6ff)](https://github.com/StarksLabs/epic-fab/commits)
[![Stars](https://img.shields.io/github/stars/StarksLabs/epic-fab?style=flat&logo=github&color=7ee787)](https://github.com/StarksLabs/epic-fab/stargazers)
[![Issues](https://img.shields.io/github/issues/StarksLabs/epic-fab?style=flat&logo=github&color=d2a8ff)](https://github.com/StarksLabs/epic-fab/issues)

<!-- Tech -->
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-%E2%89%A51.0-FBF0DF?style=flat&logo=bun&logoColor=black)](https://bun.sh/)
[![Linux](https://img.shields.io/badge/Linux-native-FCC624?style=flat&logo=linux&logoColor=black)](https://www.linux.org/)
[![Unreal Engine](https://img.shields.io/badge/Unreal%20Engine-5.x-313131?style=flat&logo=unrealengine&logoColor=white)](https://www.unrealengine.com/)
[![Epic Games](https://img.shields.io/badge/Epic%20Games-compatible-313131?style=flat&logo=epicgames&logoColor=white)](https://store.epicgames.com/)
[![Built with Claude Code](https://img.shields.io/badge/Built%20with-Claude%20Code-D97757?style=flat&logo=anthropic&logoColor=white)](https://www.anthropic.com/claude-code)
[![Built with PAI](https://img.shields.io/badge/Built%20with-PAI-8B5CF6?style=flat&logo=github&logoColor=white)](https://github.com/danielmiessler/PAI)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?style=flat&logo=discord&logoColor=white)](https://discord.gg/cmTXqECZ)

<br/>

# Epic-Fab

</div>

---

## ✨ What it is

Epic Games has never shipped a Launcher for Linux. The Fab plugin, Quixel Bridge, and the entire Epic-account-bound asset library are Launcher-distributed binaries — Linux users running Unreal Engine get locked out of assets they legitimately own (Fab purchases, free monthly drops, Quixel Megascans, UE Marketplace items).

`epic-fab` closes the gap. One Bun-runtime binary, one OAuth login, your entire Fab library available at the command line.

- **Browse** every asset in your library as JSON, pipeable into anything.
- **Download** any asset to a target directory — chunk-reassembled, SHA1-verified, multi-CDN aware.
- **Sync** a UE project: bulk-pull your library straight into `<project>/Content/Fab/`.
- **Works against your real Epic account.** Real OAuth, real `accounts.fab.com` API, real CDN-signed manifests.

No Wine. No Heroic shim. No Epic Launcher running under emulation. Just the Linux tools you already use.

---

## 🚀 Quickstart

```bash
git clone https://github.com/starkslabs/epic-fab.git ~/Projects/epic-fab
cd ~/Projects/epic-fab
bun install
bun link                              # `epic-fab` now on $PATH

epic-fab auth                         # one-time browser login
epic-fab list | head -20              # see your library
epic-fab download <asset-id> --into /tmp/asset
```

Tokens land at `~/.config/epic-fab/auth.json` (mode `600`, never in URLs, never in logs). Refresh happens transparently when the access token expires mid-session.

---

## 📦 Commands

| Command | What it does |
|---|---|
| `epic-fab auth` | One-time Epic OAuth — prints a login URL, you paste the authorization code back |
| `epic-fab whoami` | Show the authenticated Epic account display name + ID |
| `epic-fab list` | JSON dump of every owned Fab asset (id, title, type, ownedAt) |
| `epic-fab download <id> --into <dir>` | Download a single asset to a target directory |
| `epic-fab sync --project <path>` | Bulk-download library into a UE project's `Content/Fab/` tree |
| `epic-fab tui` | Browse and filter interactively; `Enter` downloads and `Ctrl+O` opens Fab |
| `epic-fab logout` | Delete persisted auth tokens |

Every command exits with a meaningful code (`0` OK, `1` user error, `2` not authenticated, `3` network error). The non-interactive result commands emit JSON on stdout for piping; `tui` is interactive.

### Interactive TUI

```bash
epic-fab tui --lang zh-CN
```

The TUI filters as you type. Use `↑`/`↓` to select, `Enter` to download, `Ctrl+O`
to open the original Fab listing, `Ctrl+I` to open the selected asset's thumbnail,
and `Esc` to quit.
All TUI text lives in [`src/locales/en.json`](./src/locales/en.json) and
[`src/locales/zh-CN.json`](./src/locales/zh-CN.json). Add any
`src/locales/<locale>.json` file (for example, `fr-FR.json`) and use
`epic-fab tui --lang <locale>`; a missing or invalid file falls back to English.

---

## 🧠 How it works

`epic-fab` speaks Epic's launcher-OAuth dialect — the same `launcherAppClient2` flow Linux community tooling (Legendary, Heroic) has converged on — and the Fab account-library REST API that the desktop Launcher uses internally.

```
┌─────────────────┐    1. browser OAuth    ┌────────────────────┐
│  you  +  epic-  │ ◄─────────────────────► │  account-public-    │
│  fab terminal   │    code + tokens       │  service-prod03     │
└────────┬────────┘                        └────────────────────┘
         │ 2. bearer token
         ▼
┌─────────────────┐  3. /e/accounts/{id}/  ┌────────────────────┐
│  Fab REST API   │ ◄─────── ue/library ── │  www.fab.com        │
│                 │  /e/artifacts/{id}/    └────────────────────┘
└────────┬────────┘  manifest (POST)
         │ 4. signed manifest URL
         ▼
┌─────────────────┐  5. parallel chunks    ┌────────────────────┐
│  binary mani-   │  (SHA1 verified per    │  CloudFront /       │
│  fest parser    │  file, GUID-dedup'd)   │  Akamai / Fastly    │
└─────────────────┘                        └────────────────────┘
```

Under the hood: Epic's binary manifest format (magic `0x44BEC00C`), chunk database lookup, parallel chunked fetch with bounded concurrency, zlib decompression, per-file SHA1 verification against the canonical hash Epic publishes. Multi-CDN failover, no shell interpolation on external input, no token in any URL.

---

## 🤝 Contributing

PRs welcome — especially around: additional engine-version coverage, JSON-manifest support for legacy assets, container/Nix packaging, integration test fixtures from real downloads. See [`ISA.md`](./ISA.md) for the project's living ideal-state articulation — that's the source of truth for what "done" looks like.

---

## 🙏 Acknowledgments

- **[Legendary](https://github.com/derrod/legendary)** by [@derrod](https://github.com/derrod) — the canonical reference for Epic's OAuth and binary manifest format. `epic-fab`'s parser is ported from Legendary's layout.
- **[egs-api-rs](https://github.com/AchetaGames/egs-api-rs)** — the most complete recent Rust integration for the Fab side of Epic's API surface.
- **[PAI ecosystem](https://github.com/danielmiessler/PAI)** — built as a contribution to Daniel Miessler's framework for personal AI infrastructure.

---

## 📜 License

[MIT](./LICENSE) © 2026 [Starks Labs](https://github.com/starkslabs)

---

## ❓ FAQ

<details>
<summary><b>Will this get my Epic account banned?</b></summary>

`epic-fab` uses the same OAuth client and the same public Fab endpoints the official Launcher uses. It's identical-to-Launcher traffic from Epic's side. Long-standing Linux tools — Legendary, Heroic — have used this approach for years without reports of account action. That said: no warranty. Read the license.

</details>

<details>
<summary><b>Why not just Wine the Launcher?</b></summary>

Tried that road. The Launcher under Wine is fragile, slow, breaks on every Epic update, and offers no scripting surface. `epic-fab` is one Bun binary, ~600 lines per module, fully scriptable, no GUI dependency.

</details>

<details>
<summary><b>Does this work with Unreal Engine on Linux?</b></summary>

Yes. The downloaded `.uasset` / `.uproject` content is the same content the Launcher delivers on Windows / Mac. UE 5.x on Linux opens it natively. Engine-version-aware: `epic-fab` defaults to `UE_5.7` and picks the matching artifact from each asset's available engine builds.

</details>

<details>
<summary><b>What about Quixel Megascans?</b></summary>

In scope. Megascans were absorbed into Fab and now live under the same library endpoint — `epic-fab list` surfaces them alongside marketplace assets.

</details>

<details>
<summary><b>Is this affiliated with Epic Games?</b></summary>

No. Independent open-source tool. Talks to public Epic / Fab endpoints. Not endorsed by, sponsored by, or affiliated with Epic Games, Inc.

</details>

---

<div align="center">

<sub>Built with Bun · TypeScript · for Linux first, Linux always.</sub>

</div>
