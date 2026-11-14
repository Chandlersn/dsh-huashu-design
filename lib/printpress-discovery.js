import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);
const registryScript = `$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $paths=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); @(Get-ItemProperty $paths | Where-Object { $_.DisplayName -match '^(批印坊|PrintPress)(\\s|$)' } | Select-Object DisplayName,DisplayVersion,InstallLocation,UninstallString) | ConvertTo-Json -Compress`;

async function regular(file) { try { return (await fs.stat(file)).isFile(); } catch { return false; } }
async function archiveInfo(archive, version) {
  let file;
  try {
    file = await fs.open(archive, 'r');
    const prefix = Buffer.alloc(16); if ((await file.read(prefix, 0, 16, 0)).bytesRead !== 16) return false;
    const headerSize = prefix.readUInt32LE(4), jsonSize = prefix.readUInt32LE(12);
    if (prefix.readUInt32LE(0) !== 4 || headerSize < 8 || headerSize > 16 * 1024 * 1024 || jsonSize > headerSize - 8) return false;
    const header = Buffer.alloc(jsonSize); if ((await file.read(header, 0, jsonSize, 16)).bytesRead !== jsonSize) return false;
    const tree = JSON.parse(header.toString());
    const pkg = tree.files?.['package.json'];
    if (!pkg || pkg.unpacked || !Number.isSafeInteger(pkg.size) || pkg.size > 65536 || !/^\d+$/.test(pkg.offset) || !tree.files?.electron?.files?.['api.cjs']) return false;
    const offset = Number(pkg.offset); if (!Number.isSafeInteger(offset)) return false;
    const bytes = Buffer.alloc(pkg.size); if ((await file.read(bytes, 0, pkg.size, 8 + headerSize + offset)).bytesRead !== pkg.size) return false;
    const metadata = JSON.parse(bytes.toString());
    return metadata.name === 'printpress' && metadata.version === version;
  } catch { return false; } finally { await file?.close(); }
}

export async function inspectPrintpress(root, version) {
  if (!root || typeof root !== 'string') return null;
  root = path.resolve(root);
  const electron = path.join(root, 'node_modules/electron/dist/electron.exe');
  if (await regular(path.join(root, 'electron/api.cjs')) && await regular(electron)) return { kind: 'source', root, executable: electron };
  const archive = path.join(root, 'resources/app.asar'), executable = path.join(root, '批印坊.exe');
  if (await regular(executable) && await regular(archive) && await regular(path.join(root, 'resources.pak')) && await regular(path.join(root, 'icudtl.dat')) && await archiveInfo(archive, version)) return { kind: 'packaged', root, executable, domainRoot: archive, resources: path.join(root, 'resources') };
  return null;
}

export async function discoverPrintpress(version) {
  if (process.platform !== 'win32') return null;
  try {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const encoded = Buffer.from(registryScript, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(stdout || '[]');
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (item.DisplayVersion !== version || !/^(批印坊|PrintPress)(\s|$)/i.test(item.DisplayName || '')) continue;
      let root = typeof item.InstallLocation === 'string' && path.isAbsolute(item.InstallLocation) ? item.InstallLocation : '';
      if (!root && typeof item.UninstallString === 'string') {
        const match = /^"([^"\r\n]+\.exe)"(?:\s|$)/i.exec(item.UninstallString);
        if (match && path.isAbsolute(match[1]) && /^Uninstall .+\.exe$/i.test(path.basename(match[1]))) root = path.dirname(match[1]);
      }
      const result = await inspectPrintpress(root, version); if (result?.kind === 'packaged') return result;
    }
  } catch { /* Discovery is optional. */ }
  return null;
}

function makeAsar(files) {
  let offset = 0; const entries = {};
  for (const [name, content] of Object.entries(files)) { entries[name] = { size: content.length, offset: String(offset) }; offset += content.length; }
  const json = Buffer.from(JSON.stringify({ files: entries }));
  const padded = (json.length + 3) & ~3, headerSize = 8 + padded;
  const prefix = Buffer.alloc(16 + padded);
  prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(headerSize, 4); prefix.writeUInt32LE(headerSize - 4, 8); prefix.writeUInt32LE(json.length, 12); json.copy(prefix, 16);
  return Buffer.concat([prefix, ...Object.values(files)]);
}

export async function createPrintpressShim(installation, worker) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'huashu-printpress-runtime-'));
  try {
    const entries = await fs.readdir(installation.root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && !/^uninstall /i.test(entry.name)) await fs.copyFile(path.join(installation.root, entry.name), path.join(dir, entry.name));
    }
    await fs.cp(path.join(installation.root, 'locales'), path.join(dir, 'locales'), { recursive: true });
    const resources = path.join(dir, 'resources'); await fs.mkdir(resources);
    for (const name of ['models', 'seed', 'third-party', 'mcp', 'app.asar.unpacked']) {
      const target = path.join(installation.resources, name);
      try { if ((await fs.stat(target)).isDirectory()) await fs.symlink(target, path.join(resources, name), 'junction'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const entry = Buffer.from(`require(${JSON.stringify(worker)}).startWorker();\n`);
    const pkg = Buffer.from(JSON.stringify({ name: 'huashu-printpress-runtime', version: '1.0.0', main: 'main.cjs' }));
    await fs.writeFile(path.join(resources, 'app.asar'), makeAsar({ 'package.json': pkg, 'main.cjs': entry }), { flag: 'wx' });
    return { dir, executable: path.join(dir, path.basename(installation.executable)) };
  } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
}
