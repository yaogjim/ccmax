import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'

// The watcher is a job of this supervisor, never of the target shell: a
// command's bare `wait` must not wait for its lifetime watcher. Observe PIDs
// rather than an extra stdio pipe, which Bun can close during file-fd reuse.
const PARENT_PROCESS_GUARD = `
runtime_pid=$1
shift
supervisor_pid=$$
(
  poller=
  trap 'if [ -n "$poller" ]; then kill "$poller" 2>/dev/null || :; wait "$poller" 2>/dev/null || :; fi; exit 0' TERM INT HUP
  while kill -0 "$runtime_pid" 2>/dev/null && kill -0 "$supervisor_pid" 2>/dev/null; do
    sleep 0.1 &
    poller=$!
    wait "$poller" 2>/dev/null || :
    poller=
  done
  kill -KILL "-$supervisor_pid" 2>/dev/null || :
) </dev/null >/dev/null 2>&1 &
lifetime_guard=$!
"$@"
lifetime_status=$?
kill "$lifetime_guard" 2>/dev/null || :
wait "$lifetime_guard" 2>/dev/null || :
exit "$lifetime_status"
`

export function spawnWithParentProcessGuard(
  command: string,
  args: string[],
  options: SpawnOptions,
): ChildProcess {
  // Windows has no POSIX process group or /bin/sh. Retain its existing spawn
  // behavior; callers must not infer that a runtime crash killed its children.
  if (process.platform === 'win32') return spawn(command, args, options)

  return spawn('/bin/sh', [
    '-c', PARENT_PROCESS_GUARD, 'ccmax-shell-lifetime', String(process.pid), command, ...args,
  ], {
    ...options,
    // The supervisor must lead a private process group so watcher and caller
    // cancellation can reap this command without touching the runtime group.
    detached: true,
  })
}