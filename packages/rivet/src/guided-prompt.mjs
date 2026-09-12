import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { MODEL_SECRETS } from "./guided-environment.mjs";

const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;

export async function runCommand(command, args, options = {}) {
  const { cwd, env, input, inheritStdin = false } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: inheritStdin ? "inherit" : ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    if (!inheritStdin) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      const collect = (destination) => (chunk) => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
          if (!settled) {
            settled = true;
            child.kill();
            reject(
              new Error(
                `${command} ${args[0] ?? ""} output exceeded the limit`,
              ),
            );
          }
          return;
        }
        if (destination === "stdout") stdout += chunk;
        else stderr += chunk;
      };
      child.stdout.on("data", collect("stdout"));
      child.stderr.on("data", collect("stderr"));
    }
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(
          new Error(
            `${command} ${args[0] ?? ""} failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
          ),
        );
      }
    });
    if (!inheritStdin) child.stdin.end(input);
  });
}

export class GuidedInitCancelledError extends Error {
  constructor() {
    super("Rivet init: guided setup was cancelled");
    this.name = "GuidedInitCancelledError";
  }
}

export function terminalPrompt({ stdin, stdout, signal }) {
  async function question(message) {
    if (stdin.readableEnded || stdin.destroyed || stdin.closed) {
      throw new GuidedInitCancelledError();
    }
    const readline = createInterface({ input: stdin, output: stdout });
    const controller = new AbortController();
    let settled = false;
    let cancelled = false;
    const abort = () => {
      if (settled) return;
      cancelled = true;
      settled = true;
      controller.abort();
    };
    stdin.once("end", abort);
    stdin.once("close", abort);
    readline.once("close", abort);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      return await readline.question(message, { signal: controller.signal });
    } catch (error) {
      if (cancelled || error?.name === "AbortError") {
        throw new GuidedInitCancelledError();
      }
      throw error;
    } finally {
      settled = true;
      stdin.removeListener("end", abort);
      stdin.removeListener("close", abort);
      readline.removeListener("close", abort);
      signal?.removeEventListener("abort", abort);
      readline.close();
    }
  }
  return Object.freeze({
    async confirm(message) {
      const answer = (await question(`${message} [y/N] `)).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    },
    async input(message) {
      return question(`${message} `);
    },
  });
}

export async function selectModelSecret(prompt) {
  if (typeof prompt.selectModelSecret === "function") {
    const selected = await prompt.selectModelSecret(MODEL_SECRETS);
    if (MODEL_SECRETS.includes(selected)) return selected;
  } else {
    const selected = (
      await prompt.input(
        "Model secret to store [CODEX_API_KEY] (or OPENAI_API_KEY):",
      )
    )
      .trim()
      .toUpperCase();
    if (!selected) return "CODEX_API_KEY";
    if (MODEL_SECRETS.includes(selected)) return selected;
  }
  throw new Error("Rivet init: choose CODEX_API_KEY or OPENAI_API_KEY");
}
