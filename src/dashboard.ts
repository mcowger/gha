/**
 * Live dashboard for GithubAwesome Monitor.
 * Uses an alternate screen buffer so the dashboard has its own
 * clean screen — no line-counting, no moveUp, no interference.
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
const HOME = '\x1b[H';           // cursor to top-left
const ALT_SCREEN = '\x1b[?1049h';
const MAIN_SCREEN = '\x1b[?1049l';

function out(s: string): void { process.stdout.write(s); }

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

  // Switch to alternate screen buffer
  out(ALT_SCREEN);
  repaint();

  repaintTimer = setInterval(repaint, 200);
}

export function stopDashboard(): void {
  if (repaintTimer) {
    clearInterval(repaintTimer);
    repaintTimer = null;
  }
  // Final repaint
  repaint();

  // Switch back to main screen buffer
  out(MAIN_SCREEN);
  dashState = null;
}

export function setVideoTotal(n: number): void { ensureState().videosTotal = n; }
export function setProjectTotal(n: number): void { const s = ensureState(); s.projectsTotal = n; s.llmTotal = n; }

export function incVideosDone(): void { ensureState().videosDone++; }
export function incProjectsDone(): void { ensureState().projectsDone++; }
export function incLlmDone(): void { ensureState().llmDone++; }
export function incReportsWritten(): void { ensureState().reportsWritten++; }

export function setCurrentVideo(label: string): void { ensureState().currentVideo = label; }
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
}

// ── Render ──────────────────────────────────────────────────

function repaint(): void {
  if (!dashState) return;
  const s = dashState;

  // Clear and start from top-left
  out(CLEAR_SCREEN + HOME);

  const w = (s: string) => out(s + '\n');

  w(`${BOLD}${CYAN}GitHubAwesome Monitor${RESET}\n`);

  // Progress
  w(`${BOLD}Progress${RESET}`);
  w(`  Videos    ${progressBar(s.videosDone, s.videosTotal)}`);
  w(`  Projects  ${progressBar(s.projectsDone, s.projectsTotal)}`);
  w(`  LLM       ${progressBar(s.llmDone, s.llmTotal)}`);
  w(`  Reports   ${progressBar(s.reportsWritten, s.projectsTotal)}`);
  w('');

  // Concurrency
  w(`${BOLD}Concurrency${RESET}`);
  w(`  VIDEO   ${concurrencyIndicator(s.videoLimiter.activeCount, s.videoLimiter.concurrency)}`);
  w(`  PROJECT ${concurrencyIndicator(s.projectLimiter.activeCount, s.projectLimiter.concurrency)}`);
  w(`  LLM     ${concurrencyIndicator(s.llmLimiter.activeCount, s.llmLimiter.concurrency)}`);
  w(`  GH API  ${concurrencyIndicator(s.githubLimiter.activeCount, s.githubLimiter.concurrency)}`);
  w('');

  // Queues
  w(`${BOLD}Queues${RESET}`);
  w(
    `  videos: ${YELLOW}${s.videoLimiter.pendingCount}${RESET}   ` +
    `projects: ${YELLOW}${s.projectLimiter.pendingCount}${RESET}   ` +
    `llm: ${YELLOW}${s.llmLimiter.pendingCount}${RESET}   ` +
    `gh: ${YELLOW}${s.githubLimiter.pendingCount}${RESET}`
  );
  w('');

  // Current
  w(`${BOLD}Current${RESET}`);
  w(`  VIDEO    ${s.currentVideo || DIM + '—' + RESET}`);
  w(`  PROJECT  ${s.currentProject || DIM + '—' + RESET}`);
  w(`  LLM      ${s.currentLlm.length > 0 ? s.currentLlm.join(', ') : DIM + '—' + RESET}`);
  w('');

  // Recent
  w(`${BOLD}Recent${RESET}`);
  if (s.recentLines.length === 0) {
    w(`  ${DIM}waiting...${RESET}`);
  } else {
    for (const l of s.recentLines) {
      w(`  ${l}`);
    }
  }
}
