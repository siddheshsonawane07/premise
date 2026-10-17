export function makeFixBranch(opts: {
  repo: string;
  branch: string;
  message: string;
  files: { path: string; patch: string }[];
}): { branch: string; base: string; applied: string[]; skipped: { path: string; why: string }[] };
