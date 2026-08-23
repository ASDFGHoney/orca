const { fork } = require('node:child_process')

const child = fork(process.argv[2], ['4242'], { silent: true })
console.log(JSON.stringify({ hostPid: process.pid, helperPid: child.pid }))
setInterval(() => {}, 1_000)
