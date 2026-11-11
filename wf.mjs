import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIN_MAJOR = 22;
const CLONE = path.dirname(fileURLToPath(import.meta.url));

const HINTS = {
  darwin: "Install Node 22 or newer, for example with brew install node (a node that stays) or nvm install 22, then run node wf.mjs again. With nvm, set nodePath in ai-agents-setup/local.json after the install, so the hooks keep a node that stays.",
  linux: "Install Node 22 or newer from NodeSource (distribution packages are often too old): curl -fsSL https://deb.nodesource.com/setup_24.x -o nodesource_setup.sh, sudo -E bash nodesource_setup.sh, sudo apt-get install -y nodejs, then run node wf.mjs again. With nvm instead, set nodePath in ai-agents-setup/local.json after the install, so the hooks keep a node that stays.",
  win32: "Install Node 22 or newer, for example with winget install --id OpenJS.NodeJS.LTS -e, open a new terminal, go back to this clone folder (cd \"" + CLONE + "\"), then run node wf.mjs again."
};

const major = Number(String(process.versions.node).split(".")[0]);

if (!(major >= MIN_MAJOR)) {
  const hint = HINTS[process.platform] || HINTS.linux;
  process.stderr.write("wf needs Node " + MIN_MAJOR + " or newer, found " + process.versions.node + ".\n" + hint + "\n");
  process.exit(2);
}

const { main } = await import("./lib/main.mjs");
process.exitCode = await main(process.argv.slice(2));
