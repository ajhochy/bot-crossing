// Synthetic state-only HTTP fixture. All environment changes belong to this child.
import http from 'node:http'
import { apiMiddleware } from '../../server/api.mjs'

const server = http.createServer((req, res) => apiMiddleware(req, res, null))
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }))
process.on('message', message => {
  if (message === 'close') server.close(() => process.exit(0))
})
process.on('disconnect', () => server.close(() => process.exit(0)))
