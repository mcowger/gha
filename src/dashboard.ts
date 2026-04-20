/**
 * Live dashboard for GithubAwesome Monitor.
 * In a real terminal: uses an alternate screen buffer for a clean TUI.
 * In CI / non-TTY: falls back to plain console.log.
 */

import type pLimit from 'p-limit';

// ── ANSI helpers ────────────────────────────────────────────
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GRAY = '\x1b[90m';

const CLEAR_SCREEN = '\x1b[2J';
const HOME = '\x1b[H';
const ALT_SCREEN = '\x1b[?1049h';
const MAIN_SCREEN = '\x1b[?1049l';

function out(s: string): void { process.stdout.write(s); }
const isTty = process.stdout.isTTY;

// ── Dashboard state ─────────────────────────────────────────
interface DashboardState {
  videosDone: number;
  videosTotal: number;
  projectsDone: number;
  projectsTotal: number;
  llmDone: number;
  llmTotal: number;
  reportsWritten: number;

  videoLimiter: ReturnType<typeof pLimit>;
  projectLimiter: ReturnType<typeof pLimit>;
  llmLimiter: ReturnType<typeof pLimit>;
  githubLimiter: ReturnType<typeof pLimit>;

  currentVideo: string;
  currentProject: string;
  currentLlm: string[];

  recentLines: string[];
}

const MAX_RECENT = 5;
let dashState: DashboardState | null = null;
let repaintTimer: ReturnType<typeof setInterval> | null = null;

function ensureState(): DashboardState {
  if (!dashState) throw new Error('Dashboard not initialized');
  return dashState;
}

// ── Drawing helpers ─────────────────────────────────────────

function progressBar(done: number, total: number, width: number = 20): string {
  if (total === 0) return `${GRAY}${'░'.repeat(width)}${RESET} 0/0`;
  const filled = Math.round((done / total) * width);
  const empty = width - filled;
  return `${GREEN}${'█'.repeat(filled)}${RESET}${GRAY}${'░'.repeat(empty)}${RESET} ${done}/${total}`;
}

function concurrencyIndicator(active: number, max: number): string {
  const dots = Array.from({ length: max }, (_, i) =>
    i < active ? `${CYAN}●${RESET}` : `${GRAY}○${RESET}`
  ).join(' ');
  return `${dots}  ${active}/${max}`;
}

function plainProgressBar(done: number, total: number): string {
  if (total === 0) return `0/0`;
  return `${done}/${total}`;
}

// ── Public API ──────────────────────────────────────────────

export function initDashboard(
  videoLimiter: ReturnType<typeof pLimit>,
  projectLimiter: ReturnType<typeof pLimit>,
  llmLimiter: ReturnType<typeof pLimit>,
  githubLimiter: ReturnType<typeof pLimit>,
): void {
  dashState = {
    videosDone: 0,
    videosTotal: 0,
    projectsDone: 0,
    projectsTotal: 0,
    llmDone: 0,
    llmTotal: 0,
    reportsWritten: 0,
    videoLimiter,
    projectLimiter,
    llmLimiter,
    githubLimiter,
    currentVideo: '',
    currentProject: '',
    currentLlm: [],
    recentLines: [],
  };

  if (isTty) {
    out(ALT_SCREEN);
    repaint();
    repaintTimer = setInterval(repaint, 200);
  } else {
    console.log('🚀 GithubAwesome Monitor — CI mode (plain logging)\n');
  }
}

export function stopDashboard(): void {
  if (repaintTimer) {
    clearInterval(repaintTimer);
    repaintTimer = null;
  }

  if (isTty) {
    repaint();
    out(MAIN_SCREEN);
  } else if (dashState) {
    const s = dashState;
    console.log(`\n✨ Done: ${s.videosDone}/${s.videosTotal} videos, ${s.projectsDone}/${s.projectsTotal} projects, ${s.reportsWritten} reports`);
  }

  dashState = null;
}

export function setVideoTotal(n: number): void { ensureState().videosTotal = n; }
export function setProjectTotal(n: number): void { const s = ensureState(); s.projectsTotal = n; s.llmTotal = n; }

export function incVideosDone(): void {
  const s = ensureState();
  s.videosDone++;
  if (!isTty) console.log(`  📹 Videos: ${plainProgressBar(s.videosDone, s.videosTotal)}`);
}

export function incProjectsDone(): void {
  const s = ensureState();
  s.projectsDone++;
  if (!isTty && s.projectsDone % 5 === 0) console.log(`  📦 Projects: ${plainProgressBar(s.projectsDone, s.projectsTotal)}`);
}

export function incLlmDone(): void { ensureState().llmDone++; }
export function incReportsWritten(): void { ensureState().reportsWritten++; }

export function setCurrentVideo(label: string): void {
  ensureState().currentVideo = label;
  if (!isTty) console.log(`\n━━━ ${label} ━━━`);
}

export function setCurrentProject(label: string): void { ensureState().currentProject = label; }

export function addCurrentLlm(label: string): void { ensureState().currentLlm.push(label); }
export function removeCurrentLlm(label: string): void {
  const idx = ensureState().currentLlm.indexOf(label);
  if (idx >= 0) dashState!.currentLlm.splice(idx, 1);
}

export function logLine(line: string): void {
  const s = ensureState();
  s.recentLines.push(line);
  if (s.recentLines.length > MAX_RECENT) {
    s.recentLines.shift();
  }
  if (!isTty) console.log(`  ${line}`);
}

// ── Render (TUI only) ───────────────────────────────────────

function repaint(): void {
  if (!dashState || !isTty) return;
  const s = dashState;

  out(CLEAR_SCREEN + HOME);

  const w = (s: string) => out(s + '\n');

  w(`${BOLD}${CYAN}GitHubAwesome Monitor${RESET}\n`);

  w(`${BOLD}Progress${RESET}`);
  w(`  Videos    ${progressBar(s.videosDone, s.videosTotal)}`);
  w(`  Projects  ${progressBar(s.projectsDone, s.projectsTotal)}`);
  w(`  LLM       ${progressBar(s.llmDone, s.llmTotal)}`);
  w(`  Reports   ${progressBar(s.reportsWritten, s.projectsTotal)}`);
  w('');

  w(`${BOLD}Concurrency${RESET}`);
  w(`  VIDEO   ${concurrencyIndicator(s.videoLimiter.activeCount, s.videoLimiter.concurrency)}`);
  w(`  PROJECT ${concurrencyIndicator(s.projectLimiter.activeCount, s.projectLimiter.concurrency)}`);
  w(`  LLM     ${concurrencyIndicator(s.llmLimiter.activeCount, s.llmLimiter.concurrency)}`);
  w(`  GH API  ${concurrencyIndicator(s.githubLimiter.activeCount, s.githubLimiter.concurrency)}`);
  w('');

  w(`${BOLD}Queues${RESET}`);
  w(
    `  videos: ${YELLOW}${s.videoLimiter.pendingCount}${RESET}   ` +
    `projects: ${YELLOW}${s.projectLimiter.pendingCount}${RESET}   ` +
    `llm: ${YELLOW}${s.llmLimiter.pendingCount}${RESET}   ` +
    `gh: ${YELLOW}${s.githubLimiter.pendingCount}${RESET}`
  );
  w('');

  w(`${BOLD}Current${RESET}`);
  w(`  VIDEO    ${s.currentVideo || DIM + '—' + RESET}`);
  w(`  PROJECT  ${s.currentProject || DIM + '—' + RESET}`);
  w(`  LLM      ${s.currentLlm.length > 0 ? s.currentLlm.join(', ') : DIM + '—' + RESET}`);
  w('');

  w(`${BOLD}Recent${RESET}`);
  if (s.recentLines.length === 0) {
    w(`  ${DIM}waiting...${RESET}`);
  } else {
    for (const l of s.recentLines) {
      w(`  ${l}`);
    }
  }
}
