import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyInstallation } from "../src/installation-apply.mjs";

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rivet-apply-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

test("rolls back every attempted file when installation fails", async (t) => {
  const repositoryRoot = await repository(t);
  const updatedPath = path.join(repositoryRoot, "updated.txt");
  const deletedPath = path.join(repositoryRoot, "deleted.txt");
  await writeFile(updatedPath, "before update\n");
  await writeFile(deletedPath, "before delete\n");
  const plan = {
    repositoryRoot,
    files: [
      {
        path: "updated.txt",
        status: "update",
        previousSha256: sha256("before update\n"),
        content: "after update\n",
      },
      {
        path: "deleted.txt",
        status: "delete",
        previousSha256: sha256("before delete\n"),
        content: null,
      },
      {
        path: "invalid.txt",
        status: "create",
        previousSha256: null,
        content: undefined,
      },
    ],
  };

  await assert.rejects(applyInstallation(plan), TypeError);
  assert.equal(await readFile(updatedPath, "utf8"), "before update\n");
  assert.equal(await readFile(deletedPath, "utf8"), "before delete\n");
  await assert.rejects(access(path.join(repositoryRoot, "invalid.txt")), {
    code: "ENOENT",
  });
});

test("preserves a concurrent update discovered during installation", async (t) => {
  const repositoryRoot = await repository(t);
  const destination = path.join(repositoryRoot, "updated.txt");
  await writeFile(destination, "planned state\n");
  const plan = {
    repositoryRoot,
    files: [
      {
        path: "updated.txt",
        status: "update",
        previousSha256: sha256("planned state\n"),
        content: "Rivet state\n",
      },
    ],
  };

  await assert.rejects(
    applyInstallation(plan, {
      onProgress: () => writeFileSync(destination, "concurrent state\n"),
    }),
    /changed after planning/,
  );
  assert.equal(await readFile(destination, "utf8"), "concurrent state\n");
});

test("does not remove a concurrently created file", async (t) => {
  const repositoryRoot = await repository(t);
  const destination = path.join(repositoryRoot, "created.txt");
  const plan = {
    repositoryRoot,
    files: [
      {
        path: "created.txt",
        status: "create",
        previousSha256: null,
        content: "same bytes\n",
      },
    ],
  };

  await assert.rejects(
    applyInstallation(plan, {
      onProgress: () => writeFileSync(destination, "same bytes\n"),
    }),
    { code: "EEXIST" },
  );
  assert.equal(await readFile(destination, "utf8"), "same bytes\n");
});

test("does not overwrite an in-place edit during rollback", async (t) => {
  const repositoryRoot = await repository(t);
  const destination = path.join(repositoryRoot, "updated.txt");
  await writeFile(destination, "before update\n");
  const failingFile = {
    path: "invalid.txt",
    status: "create",
    previousSha256: null,
    get content() {
      writeFileSync(destination, "concurrent state\n");
      return undefined;
    },
  };
  const plan = {
    repositoryRoot,
    files: [
      {
        path: "updated.txt",
        status: "update",
        previousSha256: sha256("before update\n"),
        content: "Rivet state\n",
      },
      failingFile,
    ],
  };

  let recoveryPath;
  await assert.rejects(applyInstallation(plan), (error) => {
    assert.match(error.message, /installation failed and rollback was incomplete/);
    assert.match(error.message, /recovery files preserved at/);
    assert.equal(typeof error.recoveryPath, "string");
    recoveryPath = error.recoveryPath;
    return true;
  });
  assert.equal(await readFile(destination, "utf8"), "concurrent state\n");
  assert.equal(
    await readFile(path.join(recoveryPath, "0.backup"), "utf8"),
    "before update\n",
  );
});

test("reports recovery files after a replacement races with rollback", async (t) => {
  const repositoryRoot = await repository(t);
  const destination = path.join(repositoryRoot, "updated.txt");
  await writeFile(destination, "before update\n");
  const failingFile = {
    path: "invalid.txt",
    status: "create",
    previousSha256: null,
    get content() {
      unlinkSync(destination);
      writeFileSync(destination, "replacement state\n");
      return undefined;
    },
  };

  await assert.rejects(
    applyInstallation({
      repositoryRoot,
      files: [
        {
          path: "updated.txt",
          status: "update",
          previousSha256: sha256("before update\n"),
          content: "Rivet state\n",
        },
        failingFile,
      ],
    }),
    (error) => {
      assert.match(error.message, /recovery files preserved at/);
      assert.equal(typeof error.recoveryPath, "string");
      return true;
    },
  );
  assert.equal(await readFile(destination, "utf8"), "replacement state\n");
  const transaction = (await readdir(repositoryRoot)).find((entry) =>
    entry.startsWith(".rivet-install-"),
  );
  assert.ok(transaction);
  assert.equal(
    await readFile(path.join(repositoryRoot, transaction, "0.backup"), "utf8"),
    "before update\n",
  );
});

test("cleans its transaction after a concurrent delete", async (t) => {
  const repositoryRoot = await repository(t);
  const destination = path.join(repositoryRoot, "deleted.txt");
  await writeFile(destination, "planned state\n");
  const plan = {
    repositoryRoot,
    files: [
      {
        path: "deleted.txt",
        status: "delete",
        previousSha256: sha256("planned state\n"),
        content: null,
      },
    ],
  };

  await assert.rejects(
    applyInstallation(plan, {
      onProgress: () => unlinkSync(destination),
    }),
    { code: "ENOENT" },
  );
  assert.deepEqual(await readdir(repositoryRoot), []);
});
