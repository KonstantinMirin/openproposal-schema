/** The repository's copies of the code lists a keeper publishes outside git at a URL that serves only the latest version. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Lists } from "./lists.ts";

/**
 * A list its keeper publishes outside git stays verifiable: its URL names
 * its version, or the repository holds a copy of the file, `copy`, whose
 * SHA-256 is the list's. ISO 4217's copy also publishes the list's version
 * and holds exactly its codes, each with the first name it gives the code;
 * ISO 3166-1's holds exactly its alpha-3 codes, each with its name.
 */
export function checkListCopies(root: string, lists: Lists): string[] {
  const problems: string[] = [];
  for (const l of lists.lists) {
    if (l.version === undefined || l.sha256 === undefined) continue;
    const where = `${lists.file}: ${l.name}`;
    if (l.copy === undefined) {
      if (!l.url.includes(l.version)) problems.push(`${where}: the URL names no version, so it serves only the keeper's latest file, and the SHA-256 of version ${l.version} can't be checked again; commit a copy of the file under kernel/sources/ and name it under "copy"`);
      continue;
    }
    const file = join(root, l.copy);
    if (!existsSync(file)) {
      problems.push(`${where}: its copy ${l.copy} doesn't exist`);
      continue;
    }
    const bytes = readFileSync(file);
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (sha !== l.sha256) problems.push(`${where}: its copy ${l.copy} has the SHA-256 ${sha}, not the list's ${l.sha256}`);
    if (l.name === "ISO 3166-1 alpha-3") {
      // The iso-codes project's ISO 3166-1 file: each assigned country, with its alpha-3 code and its name.
      const rows = (JSON.parse(bytes.toString("utf8")) as { "3166-1"?: { alpha_3: string; name: string }[] })["3166-1"] ?? [];
      same(where, l, new Map(rows.map((r) => [r.alpha_3, r.name])), problems);
      continue;
    }
    if (l.name !== "ISO 4217") continue;
    const xml = bytes.toString("utf8");
    const published = /<ISO_4217 Pblshd="([^"]+)"/.exec(xml)?.[1];
    if (published !== l.version) problems.push(`${where}: its copy is published ${published ?? "on no date"}, not ${l.version}`);
    const names = new Map<string, string>();
    for (const m of xml.matchAll(/<CcyNtry>([\s\S]*?)<\/CcyNtry>/g)) {
      const code = /<Ccy>([^<]+)<\/Ccy>/.exec(m[1]!)?.[1];
      const name = /<CcyNm(?: [^>]*)?>([^<]+)<\/CcyNm>/.exec(m[1]!)?.[1];
      if (code !== undefined && name !== undefined && !names.has(code)) names.set(code, name.trim());
    }
    same(where, l, names, problems);
  }
  return problems;
}

/** A list holds exactly its copy's codes, each with the name the copy gives it. */
function same(where: string, l: Lists["lists"][number], names: Map<string, string>, problems: string[]): void {
  const listed = new Map(l.codes.map((c) => [String(c.code), c.label]));
  for (const [code, name] of names) {
    if (!listed.has(code)) problems.push(`${where}: its copy lists ${code}, which the list doesn't`);
    else if (listed.get(code) !== name) problems.push(`${where}: its copy names ${code} "${name}", and the list "${listed.get(code) ?? ""}"`);
  }
  for (const code of listed.keys()) if (!names.has(code)) problems.push(`${where}: lists ${code}, which its copy doesn't`);
}
