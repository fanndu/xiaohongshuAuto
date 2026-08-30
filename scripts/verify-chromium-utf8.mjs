import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';

const outputDirectory = resolve(
  process.argv[2] ?? '.output/chrome-mv3',
);

function isUnicodeNoncharacter(codePoint) {
  return (
    (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
    (codePoint >= 0 && (codePoint & 0xfffe) === 0xfffe)
  );
}

async function listJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJavaScriptFiles(path)));
    } else if (entry.isFile() && extname(entry.name) === '.js') {
      files.push(path);
    }
  }

  return files;
}

const decoder = new TextDecoder('utf-8', { fatal: true });
const failures = [];

for (const path of await listJavaScriptFiles(outputDirectory)) {
  let source;
  try {
    source = decoder.decode(await readFile(path));
  } catch {
    failures.push(`${relative(outputDirectory, path)}: malformed UTF-8 bytes`);
    continue;
  }

  let offset = 0;
  for (const character of source) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && isUnicodeNoncharacter(codePoint)) {
      failures.push(
        `${relative(outputDirectory, path)}: Unicode noncharacter U+${codePoint
          .toString(16)
          .toUpperCase()
          .padStart(4, '0')} at UTF-16 offset ${offset}`,
      );
    }
    offset += character.length;
  }
}

if (failures.length > 0) {
  console.error(
    `Chromium-compatible UTF-8 validation failed:\n${failures
      .map((failure) => `- ${failure}`)
      .join('\n')}`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `Chromium-compatible UTF-8 validation passed for ${outputDirectory}`,
  );
}
