import type { Shared } from './shared.js'

export interface Main extends Shared {
  label: string
}

export declare function runMain(m: Main): void
