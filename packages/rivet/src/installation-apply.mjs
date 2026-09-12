import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
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

function isWithinDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function resolveRepositoryRootRealPath(repositoryRoot) {
  const absoluteRoot = path.resolve(repositoryRoot);
  try {
    const metadata = await lstat(absoluteRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Rivet installer: repository root must be a directory");
    }
    return realpath(absoluteRoot);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Rivet installer: repository root does not exist", {
        cause: error,
      });
    }
    throw error;
  }
}

async function validateManagedDestination(
  repositoryRoot,
  filePath,
  repositoryRootRealPath,
) {
  const absoluteRoot = path.resolve(repositoryRoot);
  const destination = path.resolve(absoluteRoot, filePath);
  if (!isWithinDirectory(absoluteRoot, destination)) {
    throw new Error(
      `Rivet installer: managed path escapes repository root: ${filePath}`,
    );
  }

  const segments = path.relative(absoluteRoot, destination).split(path.sep);
  let current = absoluteRoot;
  for (const [index, segment] of segments.entries()) {
    if (!segment) continue;
    current = path.join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }

    const isLeaf = index === segments.length - 1;
    if (metadata.isSymbolicLink()) {
      if (isLeaf) {
        throw new Error(
          `Rivet installer: managed path is not a regular file: ${destination}`,
        );
      }
      let resolved;
      try {
        resolved = await realpath(current);
      } catch (error) {
        throw new Error(
          `Rivet installer: managed path has an unresolved symlink ancestor: ${current}`,
          { cause: error },
        );
      }
      if (!isWithinDirectory(repositoryRootRealPath, resolved)) {
        throw new Error(
          `Rivet installer: managed path ${filePath} resolves outside repository root through symlink: ${current} -> ${resolved}`,
        );
      }
    } else if (isLeaf && !metadata.isFile()) {
      throw new Error(
        `Rivet installer: managed path is not a regular file: ${destination}`,
      );
    }
  }
}

async function validatePlanDestinations(plan, repositoryRootRealPath) {
  for (const file of plan.files) {
    await validateManagedDestination(
      plan.repositoryRoot,
      file.path,
      repositoryRootRealPath,
    );
  }
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

async function planStartingState(plan, repositoryRootRealPath) {
  const startingState = new Map();
  for (const file of plan.files) {
    await validateManagedDestination(
      plan.repositoryRoot,
      file.path,
      repositoryRootRealPath,
    );
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
  const validateDestination = () =>
    validateManagedDestination(
      mutation.repositoryRoot,
      mutation.file.path,
      mutation.repositoryRootRealPath,
    );
  await validateDestination();
  const currentIdentity = await fileIdentity(mutation.destination);
  if (mutation.file.status === "create") {
    if (mutation.installedIdentity === null) return;
    if (currentIdentity !== mutation.installedIdentity) {
      throw new Error(
        `Rivet installer: ${mutation.file.path} changed during rollback`,
      );
    }
    await validateDestination();
    await rename(mutation.destination, rollbackPath);
    const captured = await readFile(rollbackPath, "utf8");
    if (captured !== mutation.file.content) {
      await validateDestination();
      await link(rollbackPath, mutation.destination);
      await unlink(rollbackPath);
      throw new Error(
        `Rivet installer: ${mutation.file.path} changed during rollback`,
      );
    }
    await validateDestination();
    await unlink(rollbackPath);
    return;
  }
  if (mutation.installedIdentity !== null) {
    if (currentIdentity !== mutation.installedIdentity) {
      throw new Error(
        `Rivet installer: ${mutation.file.path} changed during rollback`,
      );
    }
    await validateDestination();
    await rename(mutation.destination, rollbackPath);
    const captured = await readFile(rollbackPath, "utf8");
    if (captured !== mutation.file.content) {
      await validateDestination();
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
    await validateDestination();
    await link(mutation.backup, mutation.destination);
    await unlink(mutation.backup);
  }
  if (mutation.installedIdentity !== null) await unlink(rollbackPath);
}

export async function applyInstallation(plan, { onProgress } = {}) {
  const repositoryRoot = path.resolve(plan.repositoryRoot);
  const repositoryRootRealPath =
    await resolveRepositoryRootRealPath(repositoryRoot);
  await validatePlanDestinations(plan, repositoryRootRealPath);
  const startingState = await planStartingState(plan, repositoryRootRealPath);
  const changedFiles = plan.files.filter(
    ({ status }) => status !== "unchanged",
  );
  if (changedFiles.length > 0) {
    onProgress?.("Writing Rivet installation");
  }
  if (changedFiles.length === 0) return;
  const transactionRoot = await mkdtemp(
    path.join(repositoryRoot, ".rivet-install-"),
  );
  const attempted = [];
  try {
    for (const [index, file] of changedFiles.entries()) {
      const destination = path.join(repositoryRoot, file.path);
      const mutation = {
        file,
        destination,
        backup: null,
        installedIdentity: null,
        repositoryRoot,
        repositoryRootRealPath,
      };
      attempted.push(mutation);
      await validateManagedDestination(
        repositoryRoot,
        file.path,
        repositoryRootRealPath,
      );
      await mkdir(path.dirname(destination), { recursive: true });
      if (file.status !== "create") {
        const backup = path.join(transactionRoot, `${index}.backup`);
        await validateManagedDestination(
          repositoryRoot,
          file.path,
          repositoryRootRealPath,
        );
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
      await validateManagedDestination(
        repositoryRoot,
        file.path,
        repositoryRootRealPath,
      );
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
