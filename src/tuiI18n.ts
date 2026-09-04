export type TuiTranslate = (key: string, values?: Record<string, string | number>) => string;
const LOCALE_FILE_NAME = /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/;

function format(template: string, values: Record<string, string | number> | undefined): string {
  if (!values) return template;
  return template.replace(/\{([a-z_]+)\}/g, (whole, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : whole,
  );
}

export function localeCandidates(value: string | undefined): string[] {
  const normalized = value?.trim().replace(/\..*$/, "").replace(/_/g, "-");
  if (!normalized || !LOCALE_FILE_NAME.test(normalized)) return [];
  const language = normalized.split("-")[0]!;
  return language === normalized ? [normalized] : [normalized, language];
}

export function validateMessages(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Locale file must contain an object");
  }
  for (const [key, message] of Object.entries(value)) {
    if (typeof message !== "string") {
      throw new Error(`Locale file must map every key to a string (invalid key: ${key})`);
    }
    if (/[\u0000-\u001f\u007f-\u009f]/.test(message)) {
      throw new Error(`Locale file must not contain terminal control characters (invalid key: ${key})`);
    }
  }
  return value as Record<string, string>;
}

async function readMessages(locale: string): Promise<Record<string, string>> {
  if (!LOCALE_FILE_NAME.test(locale)) throw new Error("Invalid locale file name");
  const file = Bun.file(new URL(`./locales/${locale}.json`, import.meta.url));
  return validateMessages(await file.json());
}

export async function loadTuiTranslator(localeValue: string | undefined): Promise<TuiTranslate> {
  let fallback: Record<string, string> = {};
  try {
    fallback = await readMessages("en");
  } catch {
    // Keep the TUI usable even if a user edits the fallback file into invalid JSON.
  }
  let messages = fallback;
  for (const locale of localeCandidates(localeValue)) {
    if (locale === "en") continue;
    try {
      messages = { ...fallback, ...(await readMessages(locale)) };
      break;
    } catch {
      // Try a less-specific locale, then retain English if no valid file is found.
    }
  }
  return (key, values) => {
    const template = messages[key] ?? fallback[key] ?? key;
    return format(template, values);
  };
}
