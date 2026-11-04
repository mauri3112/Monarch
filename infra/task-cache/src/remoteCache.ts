// Vite configuration loads before workspace dependency installation.
export function remoteCacheUrl(_root: string, env = process.env) {
  // A separate variable prevents inherited T3 cache settings or credentials from opting in.
  return env.MONARCH_TASK_CACHE_URL?.trim() || undefined;
}
