// Installed only in a disposable test child, before the actual worker imports.
const { syncBuiltinESMExports } = require('node:module')
const childProcess = require('node:child_process')
const net = require('node:net')
const dgram = require('node:dgram')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const forbiddenRoot = process.env.COLONY_TEST_FORBIDDEN_ROOT
const refuse = operation => function () {
  process.send?.({ type: 'forbidden-operation', operation })
  throw new Error(`Forbidden worker operation: ${operation}`)
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = refuse(name)
net.Server.prototype.listen = refuse('TCP listen')
dgram.Socket.prototype.bind = refuse('UDP bind')
const guardPath = (original, name) => function (file, ...args) {
  const value = typeof file === 'string' ? path.resolve(file) : ''
  if (forbiddenRoot && (value === forbiddenRoot || value.startsWith(forbiddenRoot + path.sep))) {
    return refuse(`disabled-source ${name}`)()
  }
  return original.call(this, file, ...args)
}
for (const name of ['stat', 'lstat', 'access', 'readdir', 'readFile', 'open']) {
  fs[name] = guardPath(fs[name], name)
  fs[`${name}Sync`] = guardPath(fs[`${name}Sync`], `${name}Sync`)
  fsp[name] = guardPath(fsp[name], `promises.${name}`)
}
syncBuiltinESMExports()
