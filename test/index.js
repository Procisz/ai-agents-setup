const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");

const dir = __dirname;
const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";

async function importEveryTestFile() {
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".test.mjs"))
    .sort();
  for (const name of files) {
    try {
      await import(pathToFileURL(path.join(dir, name)).href);
    } catch (error) {
      test(`test file ${name} loads without throwing`, () => {
        throw error;
      });
    }
  }
}

if (entry === dir) importEveryTestFile();
