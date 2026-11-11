const args = process.argv.slice(2);
const version = process.env.FAKE_CLAUDE_VERSION ?? "2.1.312";
if (args[0] === "--version") {
  process.stdout.write(`${version} (Claude Code)\n`);
  process.exit(0);
}
if (args[0] === "plugin" && args[1] === "validate") {
  if (process.env.FAKE_CLAUDE_NO_VALIDATE === "1") {
    process.stderr.write("error: unknown command 'validate'\n");
    process.exit(1);
  }
  if (args.includes("--help")) {
    process.stdout.write("Usage: claude plugin validate [options] <path>\n");
    process.exit(0);
  }
  const ok = process.env.FAKE_CLAUDE_VALIDATE !== "fail";
  const report = { success: ok, manifest: { errors: ok ? [] : [{ message: "plugin.json: name is missing" }], warnings: [] }, contents: [] };
  process.stdout.write(JSON.stringify(report) + "\n");
  process.exit(ok ? 0 : 1);
}
process.exit(0);
