import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "./config.mjs";

async function assertOwnerDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const info = await lstat(dir);
  if (info.isSymbolicLink()) throw new ConfigError("PRIVATE_FILE", `${dir} is a symlink.`);
  const mode = info.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new ConfigError("PRIVATE_FILE", `${dir} is still readable by the group or others (mode ${mode.toString(8)}).`);
  }
}

export async function writePrivate(file, text) {
  await assertOwnerDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text, { mode: 0o600, flag: "w" });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
  await chmod(file, 0o600);
}

export async function readPrivate(file) {
  let info;
  try {
    info = await lstat(file);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ConfigError("PRIVATE_FILE", `${file} must be a regular file, not a symlink.`);
  }
  const mode = info.mode & 0o777;
  if (mode !== 0o600 && mode !== 0o400) {
    throw new ConfigError("PRIVATE_FILE", `${file} is mode ${mode.toString(8)}. Run: chmod 600 ${file}`);
  }
  return readFile(file, "utf8");
}

export async function readPrivateJson(file, label) {
  const text = await readPrivate(file);
  if (text == null) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new ConfigError("SESSION", `Could not read the ${label} file. Run: node src/cli.mjs unlink`);
  }
}

export async function removePrivate(file) {
  let info;
  try {
    info = await lstat(file);
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
  if (info.isSymbolicLink()) throw new ConfigError("PRIVATE_FILE", `Refusing to delete symlink ${file}.`);
  await rm(file);
  return true;
}

export function sessionPath(configDir) {
  return path.join(configDir, "session.json");
}

export function pendingPath(configDir) {
  return path.join(configDir, "pending.json");
}
