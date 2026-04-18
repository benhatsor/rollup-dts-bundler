import type { Shared } from './shared.js'

export interface Cli extends Shared {
  argv: string[]
}

export declare function runCli(c: Cli): void
