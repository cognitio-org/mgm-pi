import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { assertPrivateFile } from "./config.mjs";

const execFileAsync = promisify(execFile);

export const HTTPS_REDIRECT = "https://127.0.0.1:8787/callback";

const CA_CONFIG = `[req]
distinguished_name = dn
x509_extensions = ca_ext
prompt = no
[dn]
CN = Enable Banking local callback
[ca_ext]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
nameConstraints = critical,permitted;IP:127.0.0.1/255.255.255.255
subjectKeyIdentifier = hash
`;

const LEAF_CONFIG = `[req]
distinguished_name = dn
req_extensions = req_ext
prompt = no
[dn]
CN = 127.0.0.1
[req_ext]
subjectAltName = IP:127.0.0.1
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
`;

export function tlsDirectory() {
  return path.join(homedir(), ".config", "enablebanking", "tls");
}

function pathsIn(dir) {
  return {
    dir,
    caKey: path.join(dir, "ca.key"),
    caCrt: path.join(dir, "ca.crt"),
    leafKey: path.join(dir, "callback.key"),
    leafCrt: path.join(dir, "callback.crt"),
  };
}

async function exists(file) {
  try {
    await readFile(file);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

async function verify(paths) {
  await execFileAsync("openssl", ["verify", "-CAfile", paths.caCrt, paths.leafCrt]);
}

export async function ensureCallbackTls(dir = tlsDirectory()) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const paths = pathsIn(dir);
  const present = await Promise.all([paths.caKey, paths.caCrt, paths.leafKey, paths.leafCrt].map(exists));
  if (present.every(Boolean)) {
    try {
      await verify(paths);
    } catch {
      throw new Error(`The callback certificate in ${dir} does not match its CA. Move that directory aside and run: node src/cli.mjs tls`);
    }
    return { ...paths, created: false };
  }
  if (present.some(Boolean)) {
    throw new Error(`The callback certificate in ${dir} is incomplete. Move that directory aside and run: node src/cli.mjs tls`);
  }

  const caConfig = path.join(dir, "ca.cnf");
  const leafConfig = path.join(dir, "leaf.cnf");
  const csr = path.join(dir, "callback.csr");
  const serial = path.join(dir, "ca.srl");
  await writeFile(caConfig, CA_CONFIG, { mode: 0o600 });
  await writeFile(leafConfig, LEAF_CONFIG, { mode: 0o600 });
  try {
    await execFileAsync("openssl", ["genrsa", "-out", paths.caKey, "2048"], { cwd: dir });
    await execFileAsync("openssl", ["req", "-new", "-x509", "-days", "825", "-key", paths.caKey, "-out", paths.caCrt, "-config", caConfig], { cwd: dir });
    await execFileAsync("openssl", ["genrsa", "-out", paths.leafKey, "2048"], { cwd: dir });
    await execFileAsync("openssl", ["req", "-new", "-key", paths.leafKey, "-out", csr, "-config", leafConfig], { cwd: dir });
    await execFileAsync("openssl", ["x509", "-req", "-in", csr, "-CA", paths.caCrt, "-CAkey", paths.caKey, "-CAcreateserial", "-out", paths.leafCrt, "-days", "825", "-extfile", leafConfig, "-extensions", "req_ext"], { cwd: dir });
    await chmod(paths.caKey, 0o600);
    await chmod(paths.leafKey, 0o600);
    await verify(paths);
  } finally {
    await rm(caConfig, { force: true });
    await rm(leafConfig, { force: true });
    await rm(csr, { force: true });
    await rm(serial, { force: true });
  }
  return { ...paths, created: true };
}

export async function loadCallbackTls(dir = tlsDirectory()) {
  const paths = pathsIn(dir);
  try {
    await assertPrivateFile(paths.leafKey);
    await assertPrivateFile(paths.caKey);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "PRIVATE_FILE") {
      throw new Error("The local HTTPS callback certificate is missing. Run: node src/cli.mjs tls");
    }
    throw err;
  }
  const leaf = await readFile(paths.leafCrt, "utf8");
  const ca = await readFile(paths.caCrt, "utf8");
  if (!leaf.includes("BEGIN CERTIFICATE") || !ca.includes("BEGIN CERTIFICATE")) {
    throw new Error("The local callback certificate is incomplete. Run: node src/cli.mjs tls");
  }
  return {
    key: await readFile(paths.leafKey),
    cert: `${leaf.trim()}\n${ca.trim()}\n`,
    ca,
    leafCrt: paths.leafCrt,
    caCrt: paths.caCrt,
  };
}

export async function trustCallbackCa(caCrt) {
  const keychain = path.join(homedir(), "Library/Keychains/login.keychain-db");
  await execFileAsync("security", [
    "add-trusted-cert",
    "-r", "trustRoot",
    "-p", "ssl",
    "-k", keychain,
    caCrt,
  ]);
}
