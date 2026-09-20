/* eslint-disable @typescript-eslint/no-require-imports */
'use strict'
const net = require('node:net')
const originalListen = net.Server.prototype.listen
const isLoopbackHost = (host) => host === undefined || host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
net.Server.prototype.listen = function patchedListen(...args) {
  if (typeof args[0] === 'object' && args[0] !== null) args[0] = { ...args[0], host: isLoopbackHost(args[0].host) ? (args[0].host || '127.0.0.1') : '127.0.0.1' }
  else if (typeof args[0] === 'number') args[0] = { port: args[0], host: '127.0.0.1' }
  else if (typeof args[1] === 'string' && !isLoopbackHost(args[1])) args[1] = '127.0.0.1'
  return originalListen.apply(this, args)
}
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || require('node:path').join(process.cwd(), 'user-data')
