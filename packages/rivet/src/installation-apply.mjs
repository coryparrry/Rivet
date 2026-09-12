import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rmdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

export async function existingFile(filePath) {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile()) {
      throw new Error(
        `Rivet installer: managed path is not a regular file: ${filePath}`,
      );
    }
    return readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function planStartingState(plan) {
  const startingState = new Map();
  for (const file of plan.files) {
    const current = await existingFile(
      path.join(plan.repositoryRoot, file.path),
    );
    const currentDigest = current === null ? null : digest(current);
    if (currentDigest !== file.previousSha256) {
      throw new Error(`Rivet installer: ${file.path} changed after planning`);
    }
    startingState.set(file.path, current);
  }
  return startingState;
}

async function fileIdentity(filePath) {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile()) {
      throw new Error(
        `Rivet installer: managed path is not a regular file: ${filePath}`,
      );
    }
    return `${metadata.dev}:${metadata.ino}`;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function restoreCapturedFile(mutation, rollbackPath) {
  const currentIdentity = await fileIdentity(mutation.destination);
  if (mutation.file.status === "create") {
    if (mutation.installedIdentity === null) return;
    if (currentIdentity !== mutation.installedIdentity) {
      throw new Error(
        `Rivet installer: ${mutation.file.path} changed during rollback`,
      );
    }
    await rename(mutation.destination, rollbackPath);
    const captured = await readFile(rollbackPath, "utf8");
    if (captured !== mutation.file.content) {
      await link(rollbackPath, mutation.destination);
      await unlink(rollbackPath);
      throw new Error(
        `Rivet installer: ${mutation.file.path} changed during rollback`,
      );
    }
    await unlink(rollbackPath);
    return;
  }
  if (mutation.installedIdentity !== null) {
    if (currentIdentity !== mutation.installedIdentity) {
      throw new Error(
        `Rivet installer: ${mutation.file.path} changed during rollback`,
      );
    }
    await rename(mutation.destination, rollbackPath);
    const captured = await readFile(rollbackPath, "utf8");
    if (captured !== mutation.file.content) {
      await link(rollbackPath, mutation.destination);
      await unlink(rollbackPath);
      throw new Error(
        `Rivet installer: ${mutation.file.path} changed during rollback`,
      );
    }
  } else if (currentIdentity !== null) {
    throw new Error(
      `Rivet installer: ${mutation.file.path} changed during rollback`,
    );
  }
  if (mutation.backup) {
    await link(mutation.backup, mutation.destination);
    await unlink(mutation.backup);
  }
  if (mutation.installedIdentity !== null) await unlink(rollbackPath);
}

export async function applyInstallation(plan, { onProgress } = {}) {
  const startingState = await planStartingState(plan);
  const changedFiles = plan.files.filter(
    ({ status }) => status !== "unchanged",
  );
  if (changedFiles.length > 0) {
    onProgress?.("Writing Rivet installation");
  }
  if (changedFiles.length === 0) return;
  const transactionRoot = await mkdtemp(
    path.join(plan.repositoryRoot, ".rivet-install-"),
  );
  const attempted = [];
  try {
    for (const [index, file] of changedFiles.entries()) {
      const destination = path.join(plan.repositoryRoot, file.path);
      const mutation = {
        file,
        destination,
        backup: null,
        installedIdentity: null,
      };
      attempted.push(mutation);
      await mkdir(path.dirname(destination), { recursive: true });
      if (file.status !== "create") {
        const backup = path.join(transactionRoot, `${index}.backup`);
        await rename(destination, backup);
        mutation.backup = backup;
        const captured = await readFile(mutation.backup, "utf8");
        if (captured !== startingState.get(file.path)) {
          throw new Error(
            `Rivet installer: ${file.path} changed after planning`,
          );
        }
      }
      if (file.status === "delete") continue;
      const temporary = path.join(transactionRoot, `${index}.content`);
      await writeFile(temporary, file.content, { flag: "wx", mode: 0o644 });
      await link(temporary, destination);
      await unlink(temporary);
      mutation.installedIdentity = await fileIdentity(destination);
    }
    await rm(transactionRoot, { recursive: true, force: true });
  } catch (error) {
    const rollbackErrors = [];
    for (const [index, mutation] of attempted.reverse().entries()) {
      try {
        await restoreCapturedFile(
          mutation,
          path.join(transactionRoot, `${index}.rollback`),
        );
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      let recoveryPath = null;
      try {
        await rmdir(transactionRoot);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") recoveryPath = transactionRoot;
      }
      const rollbackFailure = new AggregateError(
        [error, ...rollbackErrors],
        `Rivet installer: installation failed and rollback was incomplete${
          recoveryPath ? `; recovery files preserved at ${recoveryPath}` : ""
        }`,
        { cause: error },
      );
      rollbackFailure.recoveryPath = recoveryPath;
      throw rollbackFailure;
    }
    await rm(transactionRoot, { recursive: true, force: true });
    throw error;
  }
}
