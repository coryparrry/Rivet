#!/usr/bin/env node
import { runCli } from "../src/cli.mjs";

runCli()
  .then((result) => {
    if (result?.status === "cancelled") process.exitCode = 1;
    else if (typeof result === "number") process.exitCode = result;
  })
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
