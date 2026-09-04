import { homedir } from "node:os";
import { join } from "node:path";
import { emitKeypressEvents, type Key } from "node:readline";
import { createInterface } from "node:readline/promises";

import type { AuthTokens } from "./auth.ts";
import { fetchAssetDetail, listLibrary, resolveAsset, type FabAssetDetail, type FabAssetSummary } from "./api.ts";
import { downloadAsset } from "./download.ts";
import { loadTuiTranslator, type TuiTranslate } from "./tuiI18n.ts";

export interface TuiOptions {
  engineVersion: string;
  locale?: string;
}

export interface TuiResult {
  downloadFailed: boolean;
}

export class TuiUserError extends Error {}

export function filterAssets(
  assets: ReadonlyArray<FabAssetSummary>,
  query: string,
): FabAssetSummary[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...assets];
  return assets.filter((asset) =>
    [asset.id, asset.title, asset.type].some((value) => value.toLowerCase().includes(needle)),
  );
}

export function visibleAssetWindow(
  assets: ReadonlyArray<FabAssetSummary>,
  selected: number,
  rows: number,
): { start: number; assets: FabAssetSummary[] } {
  const start = Math.max(0, Math.min(selected - Math.floor(rows / 2), Math.max(0, assets.length - rows)));
  return { start, assets: assets.slice(start, start + rows) };
}

export function fabUrlFor(item: FabAssetSummary): string {
  for (const key of ["listingUrl", "fabUrl", "productUrl", "url"] as const) {
    const value = item.raw[key];
    if (typeof value !== "string") continue;
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && (url.hostname === "www.fab.com" || url.hostname === "fab.com")) {
        return url.toString();
      }
    } catch {
      // Use the canonical fallback below when a raw field is not a valid URL.
    }
  }
  const dashed = /^[0-9a-f]{32}$/i.test(item.id)
    ? `${item.id.slice(0, 8)}-${item.id.slice(8, 12)}-${item.id.slice(12, 16)}-${item.id.slice(16, 20)}-${item.id.slice(20)}`
    : item.id;
  return `https://www.fab.com/listings/${encodeURIComponent(dashed)}`;
}

export function thumbnailUrlFor(raw: Record<string, unknown>): string | null {
  const direct = raw["thumbnailUrl"] ?? raw["thumbnail_url"] ?? raw["thumbnail"] ?? raw["thumbUrl"];
  const candidates: unknown[] = [direct];
  for (const key of ["images", "thumbnails"] as const) {
    const list = raw[key];
    if (Array.isArray(list) && list.length > 0 && typeof list[0] === "object" && list[0] !== null) {
      candidates.push((list[0] as Record<string, unknown>)["url"]);
    }
  }
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:") return url.toString();
    } catch {
      // Continue to another possible thumbnail field.
    }
  }
  return null;
}

function assetSlug(asset: FabAssetSummary): string {
  const candidate = asset.title.length > 0 ? asset.title : asset.id;
  const slug = candidate
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug.length > 0 ? slug : "asset";
}

export function downloadTargetDir(asset: FabAssetSummary): string {
  const idSuffix = asset.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return join(homedir(), "Downloads", `${assetSlug(asset)}-${idSuffix || "asset"}`);
}

export type TuiAction = "quit" | "up" | "down" | "backspace" | "download" | "open" | "thumbnail" | "search" | "none";

export function tuiKeyAction(key: Pick<Key, "ctrl" | "meta" | "name" | "sequence">): TuiAction {
  if ((key.ctrl && key.name === "c") || key.name === "escape") return "quit";
  if (key.name === "up") return "up";
  if (key.name === "down") return "down";
  if (key.name === "backspace") return "backspace";
  if (key.name === "return" || key.name === "enter") return "download";
  if (key.ctrl && key.name === "o") return "open";
  if ((key.ctrl && key.name === "i") || key.name === "tab") return "thumbnail";
  if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) return "search";
  return "none";
}

function characterDisplayWidth(character: string): number {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined || codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) {
    return 0;
  }
  if (
    /^\p{Mark}$/u.test(character) ||
    codePoint === 0x200d ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  ) {
    return 0;
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 || codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) return 2;
  return 1;
}

export function displayWidth(value: string): number {
  let width = 0;
  for (const character of value) width += characterDisplayWidth(character);
  return width;
}

export function truncateToDisplayWidth(value: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(value) <= width) return value;
  if (width === 1) return "…";

  let truncated = "";
  let used = 0;
  for (const character of value) {
    const characterWidth = characterDisplayWidth(character);
    if (used + characterWidth > width - 1) break;
    truncated += character;
    used += characterWidth;
  }
  return `${truncated}…`;
}

export function padToDisplayWidth(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - displayWidth(value)))}`;
}

export function wrapToDisplayWidth(value: string, width: number): string[] {
  if (width <= 0) return [""];
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  for (const character of value) {
    const characterWidth = characterDisplayWidth(character);
    if (lineWidth > 0 && lineWidth + characterWidth > width) {
      lines.push(line);
      line = "";
      lineWidth = 0;
    }
    line += character;
    lineWidth += characterWidth;
  }
  if (line.length > 0 || lines.length === 0) lines.push(line);
  return lines;
}

export function safeTerminalText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

export function relatedDetailLines(translate: TuiTranslate, asset: FabAssetSummary): string[] {
  const lines = [translate("detail_fab", { url: safeTerminalText(fabUrlFor(asset)) })];
  const thumbnailUrl = thumbnailUrlFor(asset.raw);
  if (thumbnailUrl) lines.push(translate("thumbnail_link", { url: safeTerminalText(thumbnailUrl) }));
  lines.push(translate("detail_download", { path: downloadTargetDir(asset) }));
  return lines;
}

export function detailLinesFor(translate: TuiTranslate, asset: FabAssetSummary, width: number): string[] {
  const summary = [
    safeTerminalText(asset.title || asset.id),
    translate("detail_type", { type: safeTerminalText(asset.type || translate("unknown")) }),
    translate("detail_id", { id: safeTerminalText(asset.id) }),
  ].flatMap((line) => wrapToDisplayWidth(line, width));
  const related = relatedDetailLines(translate, asset);
  const downloadLine = related.pop();
  return [
    ...summary,
    ...related.map((line) => truncateToDisplayWidth(line, width)),
    ...(downloadLine ? wrapToDisplayWidth(downloadLine, width) : []),
  ];
}

function clearScreen(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}

export async function runTui(tokens: AuthTokens, opts: TuiOptions): Promise<TuiResult> {
  const t = await loadTuiTranslator(opts.locale ?? process.env["LANG"]);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new TuiUserError(t("interactive_terminal_required"));
  }

  process.stderr.write(`${t("fetching_library")}\n`);
  const assets = await listLibrary(tokens);
  let query = "";
  let selected = 0;
  let message = t("help");
  let closed = false;
  let downloading = false;
  let downloadFailed = false;
  let terminalActive = false;

  const resolveDownloadAsset = async (asset: FabAssetSummary): Promise<FabAssetDetail | null> => {
    let resolved = await resolveAsset(tokens, asset.id, opts.engineVersion);
    const title = safeTerminalText(resolved.summary.title || resolved.summary.id);
    switch (resolved.resolution.matchType) {
      case "exact":
        break;
      case "fallback":
        process.stderr.write(`${t("engine_fallback", {
          requested: safeTerminalText(resolved.resolution.requested),
          title,
          selected: safeTerminalText(resolved.resolution.selected),
        })}\n`);
        break;
      case "higher-only": {
        process.stderr.write(`${t("engine_higher", { requested: safeTerminalText(resolved.resolution.requested), title })}\n`);
        process.stderr.write(`${t("engine_available", {
          versions: resolved.resolution.available.map(safeTerminalText).join(", "),
        })}\n`);
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const picked = (await prompt.question(t("engine_prompt"))).trim();
          if (picked.length === 0 || picked === "q") return null;
          if (!resolved.resolution.available.includes(picked)) {
            process.stderr.write(`${t("engine_invalid", { value: safeTerminalText(picked) })}\n`);
            return null;
          }
          resolved = await resolveAsset(tokens, asset.id, picked);
        } finally {
          prompt.close();
        }
        break;
      }
      case "none":
        process.stderr.write(`${t("engine_none", { title })}\n`);
        return null;
    }
    return fetchAssetDetail(tokens, resolved);
  };

  const render = (): void => {
    if (!terminalActive) return;
    const matches = filterAssets(assets, query);
    selected = Math.max(0, Math.min(selected, Math.max(0, matches.length - 1)));
    const width = Math.max(80, process.stdout.columns ?? 100);
    const listWidth = Math.floor(width * 0.52);
    const detailWidth = width - listWidth - 1;
    const current = matches[selected];
    const detailLines = current ? detailLinesFor(t, current, detailWidth) : [];
    const rows = Math.max(Math.max(6, (process.stdout.rows ?? 24) - 8), detailLines.length);
    const window = visibleAssetWindow(matches, selected, rows);
    clearScreen();
    process.stdout.write(`${t("search_status", { matches: matches.length, total: assets.length, query: safeTerminalText(query) })}\n`);
    process.stdout.write(`${"─".repeat(listWidth)}┬${"─".repeat(detailWidth)}\n`);
    for (let index = 0; index < rows; index += 1) {
      const asset = window.assets[index];
      const marker = window.start + index === selected ? "›" : " ";
      const list = asset
        ? truncateToDisplayWidth(
          `${marker} ${safeTerminalText(asset.title || asset.id)}  [${safeTerminalText(asset.type || t("unknown"))}]`,
          listWidth,
        )
        : "";
      const detail = detailLines[index] ?? "";
      process.stdout.write(`${padToDisplayWidth(list, listWidth)}│${detail}\n`);
    }
    process.stdout.write(`${"─".repeat(width)}\n`);
    process.stdout.write(`${truncateToDisplayWidth(message, width)}\n`);
  };

  const leaveTerminal = (): void => {
    if (!terminalActive) return;
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write("\x1b[?25h\x1b[?1049l");
    terminalActive = false;
  };

  const enterTerminal = (): void => {
    if (closed || terminalActive) return;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write("\x1b[?1049h\x1b[?25l");
    terminalActive = true;
  };

  const restore = (): void => {
    if (closed) return;
    closed = true;
    leaveTerminal();
  };

  let onKeypress: ((_input: string, key: Key) => void) | undefined;
  let resolveRun: (() => void) | undefined;
  let finished = false;
  let terminationSignal: NodeJS.Signals | undefined;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    resolveRun?.();
  };
  const onSigint = (): void => {
    terminationSignal = "SIGINT";
    finish();
  };
  const onSigterm = (): void => {
    terminationSignal = "SIGTERM";
    finish();
  };
  const onSighup = (): void => {
    terminationSignal = "SIGHUP";
    finish();
  };

  try {
    await new Promise<void>((resolve) => {
      resolveRun = resolve;
      onKeypress = (_input: string, key: Key): void => {
      const matches = filterAssets(assets, query);
      const action = tuiKeyAction(key);
      if (action === "quit") {
        if (downloading) {
          message = t("download_in_progress");
          return render();
        }
        return finish();
      }
      if (action === "up") selected = Math.max(0, selected - 1);
      else if (action === "down") selected = Math.min(Math.max(0, matches.length - 1), selected + 1);
      else if (action === "backspace") {
        query = query.slice(0, -1);
        selected = 0;
      } else if (action === "open" && matches[selected]) {
        const url = fabUrlFor(matches[selected]);
        message = t("opening_fab");
        void (async () => {
          try {
            const child = Bun.spawn(["xdg-open", url], { stdio: ["ignore", "ignore", "ignore"] });
            if ((await child.exited) === 0) message = t("opened_fab");
            else message = t("open_fab_failed");
          } catch {
            message = t("open_fab_failed");
          }
          render();
        })();
      } else if (action === "thumbnail" && matches[selected]) {
        const thumbnailUrl = thumbnailUrlFor(matches[selected].raw);
        if (!thumbnailUrl) {
          message = t("thumbnail_unavailable");
          return render();
        }
        message = t("opening_thumbnail");
        void (async () => {
          try {
            const child = Bun.spawn(["xdg-open", thumbnailUrl], { stdio: ["ignore", "ignore", "ignore"] });
            if ((await child.exited) === 0) message = t("opened_thumbnail");
            else message = t("open_thumbnail_failed");
          } catch {
            message = t("open_thumbnail_failed");
          }
          render();
        })();
      } else if (action === "download" && matches[selected]) {
        if (downloading) {
          message = t("download_already_in_progress");
          return render();
        }
        const asset = matches[selected];
        downloading = true;
        message = t("downloading", { title: safeTerminalText(asset.title || asset.id) });
        leaveTerminal();
        process.stderr.write(`${message}\n`);
        void (async () => {
          try {
            const detail = await resolveDownloadAsset(asset);
            if (!detail) {
              message = t("download_cancelled");
              return;
            }
            const targetDir = downloadTargetDir(detail);
            await downloadAsset(detail, { targetDir, preserveStructure: true, quiet: true });
            message = t("downloaded", { path: targetDir });
          } catch (err) {
            downloadFailed = true;
            message = t("download_failed", { error: safeTerminalText(err instanceof Error ? err.message : String(err)) });
          } finally {
            downloading = false;
            enterTerminal();
            render();
          }
        })();
      } else if (action === "search" && key.sequence) {
        query += key.sequence;
        selected = 0;
      }
      render();
      };

      emitKeypressEvents(process.stdin);
      process.stdin.on("keypress", onKeypress);
      process.once("SIGINT", onSigint);
      process.once("SIGTERM", onSigterm);
      process.once("SIGHUP", onSighup);
      enterTerminal();
      render();
    });
  } finally {
    if (onKeypress) process.stdin.off("keypress", onKeypress);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("SIGHUP", onSighup);
    restore();
  }

  if (terminationSignal) process.kill(process.pid, terminationSignal);
  return { downloadFailed };
}
