function normalizePattern(pattern: string): string {
  return pattern.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\//, "");
}

function escapeRegex(character: string): string {
  return /[|\\{}()[\]^$+?.]/.test(character) ? `\\${character}` : character;
}

function globRegex(pattern: string): RegExp {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        expression += pattern[index + 1] === "/" ? "(?:.*/)?" : ".*";
        if (pattern[index + 1] === "/") index += 1;
      } else {
        expression += "[^/]*";
      }
    } else {
      expression += character === "?" ? "[^/]" : escapeRegex(character);
    }
  }
  return new RegExp(`^${expression}(?:/.*)?$`);
}

export interface IgnoreMatcher {
  ignores(relativePath: string, isDirectory: boolean): boolean;
}

/**
 * Creates an explicit, root-relative glob matcher. A trailing slash limits a rule to directories.
 * `.git` directory segments are always excluded because VCS internals are not corpus content.
 */
export function createIgnoreMatcher(patterns: readonly string[] = []): IgnoreMatcher {
  const rules = patterns
    .map((raw) => raw.trim())
    .filter((raw) => raw.length > 0 && !raw.startsWith("#"))
    .map((raw) => {
      const directoryOnly = raw.endsWith("/");
      const normalized = normalizePattern(directoryOnly ? raw.slice(0, -1) : raw);
      const matchAnywhere = !normalized.includes("/");
      return {
        directoryOnly,
        regex: globRegex(matchAnywhere ? `**/${normalized}` : normalized),
      };
    });

  return {
    ignores(relativePath, isDirectory) {
      const normalized = normalizePattern(relativePath);
      if (normalized.split("/").includes(".git")) return true;
      return rules.some(
        (rule) => (!rule.directoryOnly || isDirectory) && rule.regex.test(normalized),
      );
    },
  };
}
