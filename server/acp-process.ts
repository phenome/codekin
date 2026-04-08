import { EventEmitter } from 'events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { resolve as resolvePath, dirname } from 'path'
import { randomUUID } from 'crypto'
import { Readable, Writable } from 'stream'
import { spawn, type ChildProcess } from 'child_process'
import * as acp from '@agentclientprotocol/sdk'
import type { AgentProcess, AgentProcessOptions } from './agent-process.js'
import { SCREENSHOTS_DIR } from './config.js'

interface TerminalState {
  proc: ChildProcess
  output: string
  limit: number
  exitCode: number | null
  signal: string | null
  released: boolean
  waiters: Array<(status: { exitCode?: number | null; signal?: string | null }) => void>
}

interface PendingPrompt {
  resolve: (response: acp.RequestPermissionResponse) => void
  options: Map<string, acp.PermissionOption>
}

const DEFAULT_OUTPUT_LIMIT = 64 * 1024

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return {}
}

function summarizeText(text: string, max = 80): string {
  const singleLine = text.replace(/\s+/g, ' ').trim()
  if (!singleLine) return ''
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine
}

function mapToolName(kind: acp.ToolKind | undefined, title: string): string {
  switch (kind) {
    case 'read': return 'Read'
    case 'edit':
    case 'move':
    case 'delete': return 'Edit'
    case 'search': return 'Grep'
    case 'execute': return 'Bash'
    case 'fetch': return 'WebFetch'
    case 'think': return 'Task'
    case 'switch_mode': return 'EnterPlanMode'
    default:
      return title || 'ACPTool'
  }
}

function buildToolInput(update: acp.ToolCall | acp.ToolCallUpdate): Record<string, unknown> {
  const rawInput = parseJsonObject(update.rawInput)
  const firstLocation = update.locations?.[0]?.path
  if (!rawInput.file_path && typeof firstLocation === 'string') rawInput.file_path = firstLocation
  if (!rawInput.path && typeof firstLocation === 'string') rawInput.path = firstLocation
  if (typeof update.title === 'string' && !rawInput.title) rawInput.title = update.title
  if (typeof update.kind === 'string' && !rawInput.kind) rawInput.kind = update.kind
  return rawInput
}

function buildPromptOptions(options: acp.PermissionOption[]): Array<{ label: string; value: string; description?: string }> {
  return options.map(option => ({
    label: option.name,
    value: option.optionId,
    description: option.kind.replace(/_/g, ' '),
  }))
}

function collectToolContent(content: acp.ToolCallContent[] | null | undefined): { text: string; image?: { base64: string; mediaType: string } } {
  const parts: string[] = []
  let image: { base64: string; mediaType: string } | undefined

  for (const item of content || []) {
    if (item.type === 'content') {
      const block = item.content
      if (block.type === 'text') {
        parts.push(block.text)
      } else if (block.type === 'image') {
        image = { base64: block.data, mediaType: block.mimeType }
      }
    } else if (item.type === 'diff') {
      const path = item.path || 'diff'
      const oldText = item.oldText || ''
      const newText = item.newText || ''
      parts.push(`Diff for ${path}\n--- before\n${oldText}\n--- after\n${newText}`)
    }
  }

  return { text: parts.join('\n').trim(), image }
}

function withinAllowedPath(targetPath: string, allowedRoots: string[]): boolean {
  const resolvedTarget = resolvePath(targetPath)
  return allowedRoots.some(root => resolvedTarget === root || resolvedTarget.startsWith(`${root}/`) || resolvedTarget.startsWith(`${root}\\`))
}

function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
}

function normalizeSignal(signal: NodeJS.Signals | null): string | null {
  return signal ?? null
}

export class AcpProcess extends EventEmitter implements AgentProcess, acp.Client {
  private proc: ChildProcess | null = null
  private connection: acp.ClientSideConnection | null = null
  private sessionId: string
  private alive = false
  private receivedOutput = false
  private spawnFailed = false
  private sessionConflict = false
  private terminals = new Map<string, TerminalState>()
  private pendingPrompts = new Map<string, PendingPrompt>()
  private toolCalls = new Map<string, { title: string; toolName: string; input: Record<string, unknown> }>()
  private suppressReplay = false
  private readonly workingDir: string
  private readonly extraEnv: Record<string, string>
  private readonly resume: boolean
  private readonly command: string
  private readonly args: string[]
  private readonly allowedRoots: string[]

  constructor(workingDir: string, opts: Partial<AgentProcessOptions> = {}) {
    super()
    this.workingDir = workingDir
    this.sessionId = opts.sessionId || randomUUID()
    this.extraEnv = opts.extraEnv || {}
    this.resume = !!(opts.resume && opts.sessionId)
    this.command = opts.acpCommand || process.execPath
    this.args = opts.acpArgs || []
    this.allowedRoots = [...new Set([resolvePath(workingDir), resolvePath(SCREENSHOTS_DIR), ...(this.extraEnv.CLAUDE_PROJECT_DIR ? [resolvePath(this.extraEnv.CLAUDE_PROJECT_DIR)] : [])])]
  }

  start(): void {
    if (this.proc) return
    if (!existsSync(this.workingDir)) {
      this.spawnFailed = true
      this.emit('error', `Working directory does not exist: ${this.workingDir}`)
      process.nextTick(() => this.emit('exit', 1, null))
      return
    }

    this.proc = spawn(this.command, this.args, {
      cwd: this.workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...this.extraEnv,
        NODE_NO_WARNINGS: '1',
      },
      windowsHide: true,
    })
    this.alive = true

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (!text) return
      if (/already in use/i.test(text)) this.sessionConflict = true
      this.emit('error', `[acp stderr] ${text.slice(0, 500)}`)
    })

    this.proc.on('error', (err) => {
      const errno = (err as NodeJS.ErrnoException).code
      if (errno === 'ENOENT' || errno === 'EACCES') this.spawnFailed = true
      this.emit('error', err.message)
    })

    this.proc.on('close', (code, signal) => {
      this.alive = false
      this.connection = null
      this.proc = null
      for (const terminalId of this.terminals.keys()) this.releaseTerminalInternal(terminalId)
      for (const [requestId, pending] of this.pendingPrompts) {
        pending.resolve({ outcome: { outcome: 'cancelled' } })
        this.pendingPrompts.delete(requestId)
      }
      this.emit('exit', code, normalizeSignal(signal))
    })

    const output = Writable.toWeb(this.proc.stdin as Writable) as WritableStream<Uint8Array>
    const input = Readable.toWeb(this.proc.stdout as Readable) as unknown as ReadableStream<Uint8Array>
    const stream = acp.ndJsonStream(output, input)
    this.connection = new acp.ClientSideConnection(() => this, stream)
    void this.initializeConnection()
  }

  private async initializeConnection(): Promise<void> {
    try {
      if (!this.connection) return
      const init = await this.connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      })
      this.receivedOutput = true
      const canLoad = init.agentCapabilities?.loadSession === true
      if (this.resume && canLoad) {
        this.suppressReplay = true
        const loaded = await this.connection.loadSession({ sessionId: this.sessionId, cwd: this.workingDir, mcpServers: [] })
        this.suppressReplay = false
        this.emit('system_init', loaded.models?.currentModelId || 'acp')
        return
      }
      const created = await this.connection.newSession({ cwd: this.workingDir, mcpServers: [] })
      this.sessionId = created.sessionId
      this.emit('system_init', created.models?.currentModelId || 'acp')
    } catch (err) {
      this.suppressReplay = false
      this.emit('error', err instanceof Error ? err.message : String(err))
      this.stop()
    }
  }

  async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const requestId = randomUUID()
    const toolInput = buildToolInput(params.toolCall)
    const title = params.toolCall.title || 'ACP tool'
    const toolName = mapToolName(params.toolCall.kind ?? undefined, title)
    const question = `Allow ${title}?`
    return await new Promise<acp.RequestPermissionResponse>((resolve) => {
      this.pendingPrompts.set(requestId, {
        resolve,
        options: new Map(params.options.map(option => [option.optionId, option])),
      })
      this.emit('prompt', 'permission', question, buildPromptOptions(params.options), false, toolName, toolInput, requestId, undefined)
    })
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    if (params.sessionId !== this.sessionId) return
    if (this.suppressReplay) return
    this.receivedOutput = true
    const update = params.update

    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text') this.emit('text', update.content.text)
        else if (update.content.type === 'image') this.emit('image', update.content.data, update.content.mimeType)
        break
      case 'agent_thought_chunk':
        if (update.content.type === 'text') this.emit('thinking', summarizeText(update.content.text))
        break
      case 'tool_call': {
        const toolInput = buildToolInput(update)
        const toolName = mapToolName(update.kind, update.title)
        this.toolCalls.set(update.toolCallId, { title: update.title, toolName, input: toolInput })
        this.emit('tool_active', toolName, summarizeText(JSON.stringify(toolInput)) || update.title)
        break
      }
      case 'tool_call_update': {
        const existing = this.toolCalls.get(update.toolCallId)
        const toolInput = update.rawInput === undefined ? (existing?.input || {}) : buildToolInput(update)
        const title = typeof update.title === 'string' ? update.title : (existing?.title || 'ACP tool')
        const toolName = mapToolName(update.kind || (toolInput.kind as acp.ToolKind | undefined), title)
        this.toolCalls.set(update.toolCallId, { title, toolName, input: toolInput })
        const { text, image } = collectToolContent(update.content)
        if (image) this.emit('image', image.base64, image.mediaType)
        if (text) this.emit('tool_output', text, update.status === 'failed')
        if (update.status === 'completed' || update.status === 'failed') {
          this.emit('tool_done', toolName, title)
        }
        break
      }
      case 'plan':
        this.emit('todo_update', update.entries.map((entry, index) => ({
          id: String(index + 1),
          subject: entry.content,
          status: entry.status === 'completed' ? 'completed' : entry.status === 'in_progress' ? 'in_progress' : 'pending',
        })))
        break
      case 'session_info_update':
        if (update.title) this.emit('tool_output', `Session renamed to: ${update.title}`, false)
        break
      default:
        break
    }
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    if (!withinAllowedPath(params.path, this.allowedRoots)) throw new Error(`Write denied outside allowed directories: ${params.path}`)
    ensureParentDir(params.path)
    writeFileSync(params.path, params.content, 'utf-8')
    return {}
  }

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    if (!withinAllowedPath(params.path, this.allowedRoots)) throw new Error(`Read denied outside allowed directories: ${params.path}`)
    const content = readFileSync(params.path, 'utf-8')
    if (!params.line && !params.limit) return { content }
    const lines = content.split(/\r?\n/)
    const start = Math.max(0, (params.line || 1) - 1)
    const end = params.limit ? start + params.limit : lines.length
    return { content: lines.slice(start, end).join('\n') }
  }

  async createTerminal(params: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse> {
    const terminalId = randomUUID()
    const cwd = params.cwd ? resolvePath(params.cwd) : this.workingDir
    if (!withinAllowedPath(cwd, this.allowedRoots)) throw new Error(`Terminal cwd denied outside allowed directories: ${cwd}`)
    const proc = spawn(params.command, params.args || [], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...Object.fromEntries((params.env || []).map(entry => [entry.name, entry.value])),
      },
      windowsHide: true,
    })
    const state: TerminalState = {
      proc,
      output: '',
      limit: params.outputByteLimit || DEFAULT_OUTPUT_LIMIT,
      exitCode: null,
      signal: null,
      released: false,
      waiters: [],
    }
    const appendOutput = (chunk: Buffer) => {
      state.output += chunk.toString()
      const encoded = Buffer.from(state.output)
      if (encoded.length > state.limit) {
        const slice = encoded.subarray(encoded.length - state.limit)
        state.output = slice.toString('utf-8')
      }
    }
    proc.stdout?.on('data', appendOutput)
    proc.stderr?.on('data', appendOutput)
    proc.on('close', (code, signal) => {
      state.exitCode = code
      state.signal = normalizeSignal(signal)
      const waiters = [...state.waiters]
      state.waiters.length = 0
      for (const resolve of waiters) resolve({ exitCode: code, signal: normalizeSignal(signal) })
    })
    this.terminals.set(terminalId, state)
    return { terminalId }
  }

  async terminalOutput(params: acp.TerminalOutputRequest): Promise<acp.TerminalOutputResponse> {
    const state = this.terminals.get(params.terminalId)
    if (!state) throw new Error(`Unknown terminal: ${params.terminalId}`)
    return {
      output: state.output,
      truncated: Buffer.from(state.output).length >= state.limit,
      exitStatus: state.exitCode !== null || state.signal !== null ? { exitCode: state.exitCode, signal: state.signal } : null,
    }
  }

  async releaseTerminal(params: acp.ReleaseTerminalRequest): Promise<acp.ReleaseTerminalResponse> {
    this.releaseTerminalInternal(params.terminalId)
    return {}
  }

  async waitForTerminalExit(params: acp.WaitForTerminalExitRequest): Promise<acp.WaitForTerminalExitResponse> {
    const state = this.terminals.get(params.terminalId)
    if (!state) throw new Error(`Unknown terminal: ${params.terminalId}`)
    if (state.exitCode !== null || state.signal !== null) return { exitCode: state.exitCode, signal: state.signal }
    return await new Promise(resolve => state.waiters.push(resolve))
  }

  async killTerminal(params: acp.KillTerminalRequest): Promise<acp.KillTerminalResponse> {
    const state = this.terminals.get(params.terminalId)
    if (!state) return {}
    if (!state.proc.killed) state.proc.kill('SIGTERM')
    return {}
  }

  private releaseTerminalInternal(terminalId: string): void {
    const state = this.terminals.get(terminalId)
    if (!state || state.released) return
    state.released = true
    if (!state.proc.killed && state.exitCode === null && state.signal === null) state.proc.kill('SIGTERM')
    const waiters = [...state.waiters]
    state.waiters.length = 0
    for (const resolve of waiters) resolve({ exitCode: state.exitCode, signal: state.signal })
    this.terminals.delete(terminalId)
  }

  sendPromptResponse(requestId: string, value: string | string[]): void {
    const pending = this.pendingPrompts.get(requestId)
    if (!pending) return
    this.pendingPrompts.delete(requestId)

    const selected = Array.isArray(value) ? value[0] : value
    if (!selected || !pending.options.has(selected)) {
      pending.resolve({ outcome: { outcome: 'cancelled' } })
      return
    }
    pending.resolve({ outcome: { outcome: 'selected', optionId: selected } })
  }

  sendControlResponse(requestId: string, behavior: 'allow' | 'deny'): void {
    this.sendPromptResponse(requestId, behavior === 'allow' ? 'allow' : 'deny')
  }

  sendMessage(content: string): void {
    if (!this.connection) {
      this.emit('error', 'ACP connection is not ready')
      return
    }
    void this.connection.prompt({
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text: content }],
    }).then((result) => {
      const isError = result.stopReason !== 'end_turn' && result.stopReason !== 'cancelled'
      this.emit('result', result.stopReason === 'end_turn' ? '' : `Turn finished: ${result.stopReason}`, isError)
    }).catch((err) => {
      this.emit('error', err instanceof Error ? err.message : String(err))
      this.emit('result', 'ACP prompt failed', true)
    })
  }

  stop(): void {
    if (this.proc) this.proc.kill('SIGTERM')
  }

  async waitForExit(timeoutMs = 10_000): Promise<void> {
    if (!this.alive) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      this.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  isAlive(): boolean { return this.alive }
  getSessionId(): string { return this.sessionId }
  hasSessionConflict(): boolean { return this.sessionConflict }
  hasSpawnFailed(): boolean { return this.spawnFailed }
  hadOutput(): boolean { return this.receivedOutput }
}
