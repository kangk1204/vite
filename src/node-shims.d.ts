declare module 'node:child_process' {
  export function execSync(command: string, options?: { encoding?: string }): string;
}
