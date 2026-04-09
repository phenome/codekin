import type { EventEmitter } from 'events'
import type { PromptQuestion, TaskItem, PermissionMode } from './types.js'

export type SessionBackend = 'claude' | 'acp'

export interface AgentProcessEvents {
  event: [unknown]
  text: [string]
  tool_output: [content: string, isError: boolean]
  system_init: [model: string]
  thinking: [summary: string]
  tool_active: [toolName: string, toolInput: string | undefined]
  tool_done: [toolName: string, summary: string | undefined]
  prompt: [promptType: 'permission' | 'question', question: string, options: Array<{label: string; value: string; description?: string}>, multiSelect: boolean | undefined, toolName: string | undefined, toolInput: Record<string, unknown> | undefined, requestId: string | undefined, questions: PromptQuestion[] | undefined]
  control_request: [requestId: string, toolName: string, toolInput: Record<string, unknown>]
  planning_mode: [active: boolean]
  todo_update: [tasks: TaskItem[]]
  image: [base64: string, mediaType: string]
  result: [text: string, isError: boolean]
  error: [message: string]
  exit: [code: number | null, signal: string | null]
}

export interface AgentProcess extends EventEmitter<AgentProcessEvents> {
  start(): void
  stop(): void
  waitForExit(timeoutMs?: number): Promise<void>
  isAlive(): boolean
  getSessionId(): string
  hasSessionConflict(): boolean
  hasSpawnFailed(): boolean
  hadOutput(): boolean
  sendMessage(content: string): void
  sendControlResponse(requestId: string, behavior: 'allow' | 'deny', updatedInput?: Record<string, unknown>, message?: string): void
  sendPromptResponse?(requestId: string, value: string | string[]): void
}

export interface AgentProcessOptions {
  workingDir: string
  sessionId?: string
  extraEnv?: Record<string, string>
  model?: string
  permissionMode?: PermissionMode
  resume?: boolean
  allowedTools?: string[]
  backend?: SessionBackend
  acpCommand?: string
  acpArgs?: string[]
}
