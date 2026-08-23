const { createHash } = require('node:crypto')
const { readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const EXPECTED_NODE_PTY_VERSION = '1.1.0'
const ORIGINAL_SOURCE_SHA256 = '0d010879bb6680a0253d44363183d53e631f42972594eb6dcb1fb842c8c85e52'
const PATCHED_SOURCE_SHA256 = '84df20cfe711a88d2bef35078615c58a6ce14f39348a4aef40e852b854dcd857'
const ORIGINAL_AGENT_OWNER_SHA256 =
  '8636d16b38266112204061a22b135734177c242837982fd3a4055be726efa64a'
const PATCHED_AGENT_OWNER_SHA256 =
  '767c27ae97a80df085ebb158ae863ec11ff6702d15c561380581213f35d02120'
const ORIGINAL_BODY = 'var consoleProcessList = getConsoleProcessList(shellPid);'
const PATCHED_BODY = `var consoleProcessList;
try {
    consoleProcessList = getConsoleProcessList(shellPid);
}
catch (_a) {
    // Why: AttachConsole can fail without a Win32 console; use node-pty's timeout fallback immediately.
    consoleProcessList = [shellPid];
}`
const ORIGINAL_OWNER_DECLARATION = `var conptyNative;
var winptyNative;`
const PATCHED_OWNER_DECLARATION = `${ORIGINAL_OWNER_DECLARATION}
var activeConsoleListAgent = null;`
const ORIGINAL_OWNER_BODY = `    WindowsPtyAgent.prototype._getConsoleProcessList = function () {
        var _this = this;
        return new Promise(function (resolve) {
            var agent = child_process_1.fork(path.join(__dirname, 'conpty_console_list_agent'), [_this._innerPid.toString()]);
            agent.on('message', function (message) {
                clearTimeout(timeout);
                resolve(message.consoleProcessList);
            });
            var timeout = setTimeout(function () {
                // Something went wrong, just send back the shell PID
                agent.kill();
                resolve([_this._innerPid]);
            }, 5000);
        });
    };`
const PATCHED_OWNER_BODY = `    WindowsPtyAgent.prototype._getConsoleProcessList = function () {
        var _this = this;
        if (activeConsoleListAgent !== null) {
            return Promise.resolve([this._innerPid]);
        }
        return new Promise(function (resolve) {
            var agent;
            try {
                agent = child_process_1.fork(path.join(__dirname, 'conpty_console_list_agent'), [_this._innerPid.toString()]);
            }
            catch (_a) {
                resolve([_this._innerPid]);
                return;
            }
            activeConsoleListAgent = agent;
            var settled = false;
            var finish = function (consoleProcessList) {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                resolve(consoleProcessList);
            };
            agent.on('message', function (message) {
                finish(message.consoleProcessList);
            });
            agent.on('error', function () {
                finish([_this._innerPid]);
            });
            agent.on('close', function () {
                if (activeConsoleListAgent === agent) {
                    activeConsoleListAgent = null;
                }
                finish([_this._innerPid]);
            });
            var timeout = setTimeout(function () {
                // Something went wrong, just send back the shell PID
                try {
                    agent.kill();
                }
                catch (_a) {
                    // Keep the slot closed until close; failure is root-only.
                }
                finish([_this._innerPid]);
            }, 5000);
        });
    };`

function inspectNodePtyConsoleListAgent(relayDir = process.cwd()) {
  const nodePtyDir = resolve(relayDir, 'node_modules', 'node-pty')
  const packageJsonPath = join(nodePtyDir, 'package.json')
  const agentPath = join(nodePtyDir, 'lib', 'conpty_console_list_agent.js')
  const agentOwnerPath = join(nodePtyDir, 'lib', 'windowsPtyAgent.js')
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  if (packageJson.version !== EXPECTED_NODE_PTY_VERSION) {
    throw new Error(
      `Refusing to patch node-pty ${packageJson.version}; expected ${EXPECTED_NODE_PTY_VERSION}`
    )
  }
  const source = readFileSync(agentPath, 'utf8')
  const agentOwnerSource = readFileSync(agentOwnerPath, 'utf8')
  return { agentOwnerPath, agentOwnerSource, agentPath, source }
}

function assertPatchedNodePtyConsoleListAgent(relayDir = process.cwd()) {
  const inspected = inspectNodePtyConsoleListAgent(relayDir)
  if (
    sourceSha256(inspected.source) !== PATCHED_SOURCE_SHA256 ||
    sourceSha256(inspected.agentOwnerSource) !== PATCHED_AGENT_OWNER_SHA256
  ) {
    throw new Error('node-pty ConPTY console-list fallback is not installed')
  }
}

function patchNodePtyConsoleListAgent(relayDir = process.cwd()) {
  const inspected = inspectNodePtyConsoleListAgent(relayDir)
  const sourceHash = sourceSha256(inspected.source)
  if (sourceHash !== ORIGINAL_SOURCE_SHA256 && sourceHash !== PATCHED_SOURCE_SHA256) {
    throw new Error('Refusing to patch unexpected node-pty console-list agent source')
  }
  const patchedSource =
    sourceHash === PATCHED_SOURCE_SHA256
      ? inspected.source
      : inspected.source.replace(ORIGINAL_BODY, PATCHED_BODY)
  const ownerHash = sourceSha256(inspected.agentOwnerSource)
  if (ownerHash !== ORIGINAL_AGENT_OWNER_SHA256 && ownerHash !== PATCHED_AGENT_OWNER_SHA256) {
    throw new Error('Refusing to patch unexpected node-pty console-list owner source')
  }
  const patchedOwnerSource =
    ownerHash === PATCHED_AGENT_OWNER_SHA256
      ? inspected.agentOwnerSource
      : inspected.agentOwnerSource
          .replace(ORIGINAL_OWNER_DECLARATION, PATCHED_OWNER_DECLARATION)
          .replace(ORIGINAL_OWNER_BODY, PATCHED_OWNER_BODY)
  installPatchedSource(inspected.agentPath, patchedSource)
  installPatchedSource(inspected.agentOwnerPath, patchedOwnerSource)
  assertPatchedNodePtyConsoleListAgent(relayDir)
}

function installPatchedSource(targetPath, source) {
  if (readFileSync(targetPath, 'utf8') === source) {
    return
  }
  const temporaryPath = `${targetPath}.orca-patch-${process.pid}`
  // Why: a terminated remote install must leave either known source version recoverable on reconnect.
  try {
    writeFileSync(temporaryPath, source)
    renameSync(temporaryPath, targetPath)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

function sourceSha256(source) {
  return createHash('sha256').update(source).digest('hex')
}

if (require.main === module) {
  patchNodePtyConsoleListAgent()
}

module.exports = {
  assertPatchedNodePtyConsoleListAgent,
  patchNodePtyConsoleListAgent
}
