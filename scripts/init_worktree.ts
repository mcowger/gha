#!/usr/bin/env bun

import { spawn } from "child_process";

type Command = {
  label: string;
  cmd: string[];
  ignoreError?: boolean;
};

const commands: Command[] = [
  { label: "Update dependencies", cmd: ["bun", "install"] },
  { label: "Fetch latest AI agent skills", cmd: ["npx", "-y", "@mcowger/agent-skills@latest"], ignoreError: true },
  { label: "Stage skill updates", cmd: ["git", "add", ".agents"], ignoreError: true },
  { label: "Commit skill updates (if any)", cmd: ["git", "commit", "-m", "chore: update agent skills"], ignoreError: true }
];

async function runCommand({ label, cmd, ignoreError }: Command) {
  console.log(`\n\x1b[36m▶ ${label}\x1b[0m`);
  console.log(`\x1b[90m$ ${cmd.join(" ")}\x1b[0m`);

  return new Promise<void>((resolve, reject) => {
    const proc = spawn(cmd[0], cmd.slice(1), { stdio: "inherit" });

    proc.on("close", (code) => {
      if (code === 0) {
        console.log(`\x1b[32m✔ Success\x1b[0m`);
        resolve();
      } else {
        const msg = `Command failed with code ${code}`;
        if (ignoreError) {
          console.log(`\x1b[33m⚠ Ignored error: ${msg}\x1b[0m`);
          resolve();
        } else {
          console.error(`\x1b[31m✖ ${msg}\x1b[0m`);
          reject(new Error(msg));
        }
      }
    });
  });
}

async function main() {
  console.log("Initializing workspace...");
  for (const command of commands) {
    try {
      await runCommand(command);
    } catch (err) {
      console.error("\x1b[31mInitialization failed. Stopping.\x1b[0m");
      process.exit(1);
    }
  }
  console.log("\n\x1b[32mWorkspace initialized successfully!\x1b[0m");
}

main();
