import type { GitHubList, RepoEntry } from './types.js';

/**
 * Language-to-color mapping for badges.
 */
const LANG_COLORS: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#3572A5',
  Rust: '#dea584',
  Go: '#00ADD8',
  Java: '#b07219',
  'C++': '#f34b7d',
  C: '#555555',
  'C#': '#178600',
  Ruby: '#701516',
  PHP: '#4F5D95',
  Swift: '#F05138',
  Kotlin: '#A97BFF',
  Dart: '#00B4AB',
  Shell: '#89e051',
  HTML: '#e34c26',
  CSS: '#563d7c',
  Scala: '#c22d40',
  Elixir: '#6e4a7e',
  Haskell: '#5e5086',
  Lua: '#000080',
  Zig: '#ec915c',
  Vue: '#41b883',
  Svelte: '#ff3e00',
};

const SOURCE_ICONS: Record<string, string> = {
  channel: '📺',
  playlist: '📋',
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '&#10;');
}

function formatStars(stars: number | null): string {
  if (stars === null || stars === undefined) return '';
  return stars >= 1000 ? `${(stars / 1000).toFixed(1)}k` : String(stars);
}

/**
 * Generate the repo feed page: a flat, newest-first list of discovered repos.
 * When `showingAll` is false (the default), the caller is expected to have
 * already filtered out repos marked `viewed`; the "Show all" toggle links to
 * `?all=true` to include them.
 */
export function generateRepoFeedHtml(
  repos: RepoEntry[],
  lastCheckedAt?: string | null,
  showingAll: boolean = false,
  lists: GitHubList[] = [],
): string {
  const listOptions = lists.map((l) => `<option value="${escapeAttr(l.id)}">${escapeHtml(l.name)}</option>`).join('');
  const cards = repos.map((r) => {
    const latestMention = r.mentions[r.mentions.length - 1];
    const icon = latestMention?.source ? SOURCE_ICONS[latestMention.source.type] || '' : '';
    const lang = r.language
      ? `<span class="lang" style="background:${LANG_COLORS[r.language] || '#8b949e'}">${escapeHtml(r.language)}</span>`
      : '';
    const stars = r.stars != null ? `<span class="stars">★ ${formatStars(r.stars)}</span>` : '';
    const summaryText = r.summary || r.description || '';
    const videoLink = latestMention
      ? `<a class="video-link" href="${escapeAttr(latestMention.videoUrl)}" target="_blank" rel="noopener">▶ ${escapeHtml(latestMention.videoTitle)}</a>`
      : '';
    const extraMentions = r.mentions.length - 1;
    const mentionCount = extraMentions > 0
      ? `<span class="mention-count">+${extraMentions} more video${extraMentions > 1 ? 's' : ''}</span>`
      : '';

    const ownerAttr = escapeAttr(r.owner);
    const repoAttr = escapeAttr(r.repo);
    const viewedControl = r.viewed
      ? `<span class="viewed-badge">✓ Viewed</span>`
      : `<button class="viewed-btn" data-owner="${ownerAttr}" data-repo="${repoAttr}" type="button" title="Mark as viewed">✓ Mark viewed</button>`;
    const starControl = r.starred
      ? `<span class="starred-badge">★ Starred</span>`
      : `<button class="star-btn" data-owner="${ownerAttr}" data-repo="${repoAttr}" type="button" title="Star this repo on GitHub">☆ Star</button>`;
    const listControl = lists.length > 0
      ? `<select class="list-select" data-owner="${ownerAttr}" data-repo="${repoAttr}" title="Add to a GitHub List">${listOptions}</select>` +
        `<button class="list-add-btn" data-owner="${ownerAttr}" data-repo="${repoAttr}" type="button">+ Add to list</button>`
      : '';

    return `
    <div class="repo-card">
      <div class="repo-top">
        ${icon ? `<span class="source-icon" title="${escapeAttr(latestMention!.source!.label)}">${icon}</span>` : ''}
        <a class="repo-name" href="${escapeAttr(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.owner)}/${escapeHtml(r.repo)}</a>
        ${lang}
        ${stars}
      </div>
      ${summaryText ? `<div class="summary">${escapeHtml(summaryText)}</div>` : ''}
      <div class="repo-meta">
        <span class="discovered-at" data-discovered-at="${escapeAttr(r.firstDiscoveredAt)}"></span>
        ${videoLink}${mentionCount}
      </div>
      <div class="repo-actions">${viewedControl}${starControl}${listControl}</div>
    </div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GithubAwesome Monitor</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
      background:#0d1117;color:#c9d1d9;min-height:100vh;
    }
    .header{
      border-bottom:1px solid #21262d;
      padding:1.25rem 1rem;
      max-width:640px;margin:0 auto;
    }
    .header-top{display:flex;align-items:flex-start;justify-content:space-between;gap:0.75rem}
    .header h1{color:#f0f6fc;font-size:1.15rem;font-weight:700;margin-bottom:0.15rem}
    .header p{color:#8b949e;font-size:0.8rem}
    .last-checked{color:#484f58;font-size:0.72rem;margin-top:0.5rem}
    .refresh-btn{
      flex-shrink:0;background:#21262d;color:#c9d1d9;border:1px solid #30363d;
      border-radius:6px;padding:0.35rem 0.7rem;font-size:0.78rem;cursor:pointer;
    }
    .refresh-btn:hover:not(:disabled){background:#30363d}
    .refresh-btn:disabled{opacity:0.6;cursor:default}
    .list{max-width:640px;margin:0 auto;padding:0.5rem 0}
    .repo-card{
      padding:0.75rem 1rem;
      border-bottom:1px solid #21262d;
    }
    .repo-card:last-child{border-bottom:none}
    .repo-top{display:flex;align-items:center;gap:0.35rem;margin-bottom:0.2rem;flex-wrap:wrap}
    .source-icon{font-size:0.85rem}
    .repo-name{color:#58a6ff;font-size:0.9rem;font-weight:600;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
    .repo-name:hover{text-decoration:underline}
    .lang{font-size:0.75rem;padding:1px 6px;border-radius:9999px;color:#fff;font-weight:600}
    .stars{color:#e3b341;font-size:0.8rem;white-space:nowrap}
    .summary{color:#8b949e;font-size:0.82rem;line-height:1.45;margin-top:0.15rem}
    .repo-meta{display:flex;align-items:center;gap:0.5rem;margin-top:0.35rem;font-size:0.78rem}
    .video-link{color:#58a6ff;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
    .video-link:hover{text-decoration:underline}
    .mention-count{color:#8b949e;flex-shrink:0}
    .discovered-at{color:#8b949e;flex-shrink:0}
    .repo-actions{display:flex;gap:0.5rem;margin-top:0.5rem}
    .viewed-btn,.star-btn{
      background:#21262d;color:#c9d1d9;border:1px solid #30363d;
      border-radius:6px;padding:0.55rem 0.9rem;font-size:0.85rem;cursor:pointer;
      min-height:44px;
    }
    .viewed-btn:hover:not(:disabled),.star-btn:hover:not(:disabled){background:#30363d}
    .viewed-btn:disabled,.star-btn:disabled{opacity:0.6;cursor:default}
    .viewed-badge{color:#3fb950;font-size:0.72rem}
    .starred-badge{color:#e3b341;font-size:0.72rem}
    .list-select,.list-add-btn{
      background:#21262d;color:#c9d1d9;border:1px solid #30363d;
      border-radius:6px;padding:0.55rem 0.9rem;font-size:0.85rem;cursor:pointer;
      min-height:44px;
    }
    .list-add-btn:hover:not(:disabled){background:#30363d}
    .list-add-btn:disabled{opacity:0.6;cursor:default}
    .toggle-all-btn{
      flex-shrink:0;background:#21262d;color:#c9d1d9;border:1px solid #30363d;
      border-radius:6px;padding:0.35rem 0.7rem;font-size:0.78rem;text-decoration:none;
    }
    .toggle-all-btn:hover{background:#30363d}
    .footer{text-align:center;padding:1.5rem 1rem;color:#484f58;font-size:0.7rem;border-top:1px solid #21262d;margin-top:1rem}
  </style>
</head>
<body>
<div class="header">
  <div class="header-top">
    <div>
      <h1>GithubAwesome Monitor</h1>
      <p>Trending projects from the GithubAwesome YouTube channel</p>
    </div>
    <a class="toggle-all-btn" href="${showingAll ? '/' : '/?all=true'}">${showingAll ? '👁 Show unviewed' : '👁 Show all'}</a>
    <button id="refresh-btn" class="refresh-btn" type="button">🔄 Refresh</button>
  </div>
  ${lastCheckedAt ? `<p class="last-checked" id="last-checked" data-checked-at="${escapeAttr(lastCheckedAt)}">Last checked: <span id="last-checked-value">${escapeHtml(lastCheckedAt)}</span></p>` : ''}
</div>
<div class="list">
${cards}
</div>
<div class="footer">Generated by github-awesome-monitor</div>
<script>
(function(){
  var lastChecked = document.getElementById('last-checked');
  if(lastChecked){
    var value = document.getElementById('last-checked-value');
    var checkedAt = new Date(lastChecked.getAttribute('data-checked-at'));
    if(!isNaN(checkedAt.getTime())){
      value.textContent = checkedAt.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    }
  }

  var discoveredEls = document.querySelectorAll('.discovered-at');
  for(var i = 0; i < discoveredEls.length; i++){
    var el = discoveredEls[i];
    var discoveredAt = new Date(el.getAttribute('data-discovered-at'));
    if(!isNaN(discoveredAt.getTime())){
      el.textContent = 'Retrieved ' + discoveredAt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }
  }

  var viewedBtns = document.querySelectorAll('.viewed-btn');
  for(var v = 0; v < viewedBtns.length; v++){
    (function(vbtn){
      vbtn.addEventListener('click', function(){
        vbtn.disabled = true;
        fetch('/api/viewed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ owner: vbtn.getAttribute('data-owner'), repo: vbtn.getAttribute('data-repo'), viewed: true }),
        })
          .then(function(res){
            if(res.ok){
              var card = vbtn.closest('.repo-card');
              if(card) card.remove();
            } else {
              vbtn.disabled = false;
            }
          })
          .catch(function(){ vbtn.disabled = false; });
      });
    })(viewedBtns[v]);
  }

  var starBtns = document.querySelectorAll('.star-btn');
  for(var s = 0; s < starBtns.length; s++){
    (function(sbtn){
      sbtn.addEventListener('click', function(){
        sbtn.disabled = true;
        sbtn.textContent = '☆ Starring…';
        fetch('/api/star', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ owner: sbtn.getAttribute('data-owner'), repo: sbtn.getAttribute('data-repo') }),
        })
          .then(function(res){
            if(res.ok){
              sbtn.outerHTML = '<span class="starred-badge">★ Starred</span>';
            } else {
              sbtn.textContent = '☆ Failed';
              sbtn.disabled = false;
            }
          })
          .catch(function(){ sbtn.textContent = '☆ Failed'; sbtn.disabled = false; });
      });
    })(starBtns[s]);
  }

  var listAddBtns = document.querySelectorAll('.list-add-btn');
  for(var l = 0; l < listAddBtns.length; l++){
    (function(lbtn){
      lbtn.addEventListener('click', function(){
        var card = lbtn.closest('.repo-card');
        var select = card ? card.querySelector('.list-select') : null;
        if(!select || !select.value) return;
        var originalText = lbtn.textContent;
        lbtn.disabled = true;
        lbtn.textContent = 'Adding…';
        fetch('/api/lists', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ owner: lbtn.getAttribute('data-owner'), repo: lbtn.getAttribute('data-repo'), listId: select.value }),
        })
          .then(function(res){
            lbtn.textContent = res.ok ? 'Added to ' + select.options[select.selectedIndex].text : 'Add failed';
          })
          .catch(function(){ lbtn.textContent = 'Add failed'; })
          .then(function(){
            setTimeout(function(){ lbtn.textContent = originalText; lbtn.disabled = false; }, 2000);
          });
      });
    })(listAddBtns[l]);
  }

  var btn = document.getElementById('refresh-btn');
  if(!btn) return;
  btn.addEventListener('click', function(){
    btn.disabled = true;
    btn.textContent = 'Refreshing…';
    fetch('/api/refresh', { method: 'POST' })
      .then(function(res){ return res.json().then(function(data){ return { ok: res.ok, data: data }; }); })
      .then(function(result){
        if(result.data && result.data.status === 'already_running'){
          btn.textContent = 'Already running…';
        } else if(result.ok){
          btn.textContent = 'Started — reload in a bit';
        } else {
          btn.textContent = 'Refresh unavailable';
          btn.disabled = false;
        }
      })
      .catch(function(){
        btn.textContent = 'Refresh failed';
        btn.disabled = false;
      });
  });
})();
</script>
</body>
</html>`;
}
