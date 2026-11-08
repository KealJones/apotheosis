import { execFileSync } from 'child_process';

/**
 * Whether background local-model work should run right now. The scheduled detector pass calls
 * this before anything that loads a model, because a loaded model holds several GB of memory
 * and on battery the inference cost shows up as drain. Explicit, user-triggered runs
 * (the `run_detectors` tool) skip the guard.
 */
export interface GuardProbe {
  onBattery(): boolean;
  /** macOS `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical. */
  memoryPressureLevel(): number;
}

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
}

/** Real probes. Each fails open (treated as plugged in / normal) if the command is missing. */
export const systemProbe: GuardProbe = {
  onBattery() {
    try {
      return run('pmset', ['-g', 'batt']).includes("'Battery Power'");
    } catch {
      return false;
    }
  },
  memoryPressureLevel() {
    try {
      return Number(run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']).trim()) || 1;
    } catch {
      return 1;
    }
  },
};

/** Why local-model work should be skipped, or null when it's fine to run. */
export function localModelBlockedReason(probe: GuardProbe = systemProbe): string | null {
  if (probe.onBattery()) return 'on battery';
  const level = probe.memoryPressureLevel();
  if (level >= 2) return `memory pressure (level ${level})`;
  return null;
}
