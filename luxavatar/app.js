'use strict';

const screening = document.querySelector('#screening');
const filmFrames = document.querySelector('.film-frames');
const films = [...filmFrames.querySelectorAll('video')];
const filmSplit = Number(filmFrames.dataset.split);
const filmDuration = Number(filmFrames.dataset.duration);
const chapters = [...document.querySelectorAll('[data-chapter]')];
let film = films[0];
let filmPart = 0;
let pendingChapter = null;
let filmTrigger = null;

const visibleLoops = new Set();
function syncLoop(video) {
  if (visibleLoops.has(video) && !document.hidden && !screening.open) {
    video.play().catch(() => {});
  } else {
    video.pause();
  }
}
function syncVisibleLoops() {
  visibleLoops.forEach(syncLoop);
}
function observeLoop(video, view = video, threshold = 0) {
  new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting && entry.intersectionRatio >= threshold) visibleLoops.add(video);
    else visibleLoops.delete(video);
    syncLoop(video);
    if (threshold > 0 && !entry.isIntersecting && video.readyState >= 1) video.currentTime = 0;
  }, { threshold: [0, threshold] }).observe(view);
}
document.addEventListener('visibilitychange', syncVisibleLoops);

// One decoded video frame supplies every canvas in a comparison.
function connectPortraitPlayback(video, view, threshold = 0) {
  const panels = [...view.querySelectorAll('canvas')].map(canvas => ({
    canvas,
    panel: canvas.parentElement,
    context: canvas.getContext('2d', { alpha: false })
  }));
  function draw() {
    if (!visibleLoops.has(video) || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    panels.forEach(({ canvas, panel, context }, index) => {
      if (panel.hidden) return;
      const width = Number(panel.dataset.width) || video.videoWidth / panels.length;
      const x = panel.hasAttribute('data-x') ? Number(panel.dataset.x) : index * width;
      const height = video.videoHeight;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.drawImage(video, x, 0, width, height, 0, 0, width, height);
    });
    view.classList.add('frame-ready');
  }

  observeFrames(video, view, draw, threshold);
  return draw;
}

// Use the decoded frame timestamp so tile layout and pixels change together on seeks and loops.
function observeFrames(video, view, paint, threshold = 0) {
  let callback = null;
  function draw(time = video.currentTime) {
    if (!visibleLoops.has(video) || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    paint(time);
    view.classList.add('frame-ready');
  }
  function queueFrame() {
    if (callback !== null || video.paused) return;
    const onFrame = (_, metadata) => {
      callback = null;
      draw(metadata?.mediaTime ?? video.currentTime);
      queueFrame();
    };
    callback = video.requestVideoFrameCallback
      ? video.requestVideoFrameCallback(onFrame)
      : requestAnimationFrame(onFrame);
  }

  video.addEventListener('loadeddata', () => draw());
  video.addEventListener('seeked', () => draw());
  video.addEventListener('playing', () => { draw(); queueFrame(); });
  video.addEventListener('pause', () => {
    if (callback === null) return;
    if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(callback);
    else cancelAnimationFrame(callback);
    callback = null;
  });
  video.addEventListener('error', () => view.classList.remove('frame-ready'));
  observeLoop(video, view, threshold);
}

connectPortraitPlayback(document.querySelector('#opening-film'), document.querySelector('.opening-panels'));
const methodView = document.querySelector('.method-demo');
const methodClock = methodView.querySelector('.method-inputs video');
const methodFollowers = [...methodView.querySelectorAll('video')].filter(track => track !== methodClock);
const inputFigures = [...methodView.querySelectorAll('.method-inputs figure')];
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
function setMethodStage(stage) {
  const previous = methodView.dataset.stage;
  if (stage === previous) return;
  const relocate = previous && (previous === 'inputs' || stage === 'inputs') && !reducedMotion.matches;
  const before = relocate ? inputFigures.map(figure => figure.getBoundingClientRect()) : [];
  methodView.dataset.stage = stage;
  if (!relocate) return;
  inputFigures.forEach((figure, index) => {
    figure.getAnimations().forEach(animation => animation.cancel());
    const from = before[index];
    const to = figure.getBoundingClientRect();
    const transform = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width})`;
    figure.animate([{ transform }, { transform: 'none' }], { duration: 620, easing: 'cubic-bezier(.22,.72,.2,1)' });
  });
}
methodFollowers.forEach(track => observeLoop(track, methodView, .15));
observeFrames(methodClock, methodView, time => {
  let stage = 'inputs';
  if (time >= 3.6 && time < 6.4) stage = 'buffers';
  if (time >= 6.4 && time < 19.6) stage = 'relit';
  setMethodStage(stage);
  methodFollowers.forEach(track => {
    if (track.readyState >= 2 && !track.seeking && Math.abs(track.currentTime - time) > .06) track.currentTime = time;
  });
}, .15);
methodClock.addEventListener('error', () => { delete methodView.dataset.stage; });

// Pack unlabelled source portraits into a single stream per exhibit for frame-locked playback.
function blit(ctx, video, x, y, size) {
  const canvas = ctx.canvas;
  if (canvas.width !== size || canvas.height !== size) canvas.width = canvas.height = size;
  ctx.drawImage(video, x, y, size, size, 0, 0, size, size);
}
function connectTiles(view, columns, size, update) {
  const video = view.querySelector('video');
  const tiles = [...view.querySelectorAll('[data-slot]')].map(tile => ({
    slot: Number(tile.dataset.slot),
    ctx: tile.querySelector('canvas').getContext('2d', { alpha: false })
  }));
  observeFrames(video, view, time => {
    for (const { slot, ctx } of tiles) blit(ctx, video, slot % columns * size, Math.floor(slot / columns) * size, size);
    if (update) update(time);
  });
}
const castView = document.querySelector('.wall-screen');
const castGrid = castView.querySelector('.cast-grid');
const castClock = document.querySelector('#wall-film');
const cast = [];
for (let y = -3; y <= 3; y++) {
  for (let x = -3; x <= 3; x++) {
    const cell = document.createElement('div');
    cell.className = 'cast-cell';
    cell.style.setProperty('--x', x);
    cell.style.setProperty('--y', y);
    const ring = Math.max(Math.abs(x), Math.abs(y));
    cell.classList.toggle('in-cast', ring < 2);
    if (ring < 2) {
      const poster = new Image();
      poster.alt = '';
      poster.loading = 'lazy';
      poster.src = 'media/gallery/portrait-' + ((y + 1) * 3 + x + 1) + '.jpg';
      cell.append(poster);
    }
    const canvas = document.createElement('canvas');
    cell.append(canvas);
    castGrid.append(cell);
    cast.push({ x, y, ring, cell, ctx: canvas.getContext('2d', { alpha: false }) });
  }
}
let castColumns = 3;
observeFrames(castClock, castView, time => {
  const frame = Math.round(time * 25);
  const columns = frame < 114 ? 3 : frame < 297 ? 5 : 7;
  const radius = (columns - 1) / 2;
  if (columns !== castColumns) {
    castGrid.style.setProperty('--columns', columns);
    cast.forEach(({ cell, ring }) => cell.classList.toggle('in-cast', ring <= radius));
    castColumns = columns;
  }
  const size = castClock.videoWidth / columns;
  for (const { x, y, ring, ctx } of cast) {
    if (ring <= radius) blit(ctx, castClock, (x + radius) * size, (y + radius) * size, size);
  }
});

const viewDemo = document.querySelector('.view-demo');
const trajectory = viewDemo.querySelector('.trajectory canvas');
const trace = trajectory.getContext('2d');
// Use the film's projected camera centers and the four corners of each image plane.
function trajectoryPath(points, closed = false) {
  const path = new Path2D();
  path.moveTo(...points[0]);
  for (let i = 1; i < points.length; i++) path.lineTo(...points[i]);
  if (closed) path.closePath();
  return path;
}
function strokeTrajectory(path, color, width) {
  trace.strokeStyle = color;
  trace.lineWidth = width;
  trace.stroke(path);
}
function trajectoryDot(point, radius, color) {
  trace.beginPath();
  trace.arc(...point, radius, 0, 2 * Math.PI);
  trace.fillStyle = color;
  trace.fill();
}

let orbit;
let trajectoryFrame = 0;
let trajectoryLight = 'R05';
function drawTrajectory(frame, light) {
  trajectoryFrame = frame;
  trajectoryLight = light;
  if (!orbit) return;

  const tip = orbit.centers[frame];
  const plane = orbit.planes[frame];
  const accent = light === 'R05' ? '#985611' : '#85499a';
  // Identical coordinate system for the starting pose, the web canvas and the film.
  trace.setTransform(2, 0, 0, 2, -100, 0);
  trace.clearRect(50, 0, 650, 340);
  trace.lineJoin = 'round';
  strokeTrajectory(orbit.rings, '#b7b7ad', 1);
  strokeTrajectory(trajectoryPath([orbit.target, tip]), '#8c908a', 1);
  trajectoryDot(orbit.target, 3.8, '#292b28');
  trace.fillStyle = '#4b4e47';
  trace.font = 'italic 25px "Times New Roman", serif';
  trace.textBaseline = 'top';
  trace.fillText('Head center', orbit.target[0] + 15, orbit.target[1] - 24);
  strokeTrajectory(orbit.path, '#70756d', 2);

  // The edit keeps a 24-frame trail, including the preceding lap at the start.
  const lap = orbit.centers.length - 1;
  const trail = [];
  for (let i = frame - 24; i <= frame; i++) trail.push(orbit.centers[(i + lap) % lap]);
  strokeTrajectory(trajectoryPath(trail), accent, 3);
  const edges = new Path2D();
  for (const corner of plane) {
    edges.moveTo(...tip);
    edges.lineTo(...corner);
  }
  strokeTrajectory(edges, accent, 1.8);
  strokeTrajectory(trajectoryPath(plane, true), accent, 2);
  trajectoryDot(tip, 4.4, accent);
}
fetch('media/viewpoint/trajectory.json').then(response => {
  if (!response.ok) throw new Error('Unable to load camera poses');
  return response.json();
}).then(({ target, rings, centers, planes }) => {
  const ringPath = new Path2D();
  rings.forEach(points => ringPath.addPath(trajectoryPath(points, true)));
  orbit = { target, rings: ringPath, centers, planes, path: trajectoryPath(centers) };
  drawTrajectory(trajectoryFrame, trajectoryLight);
  viewDemo.querySelector('.trajectory-plot img').hidden = true;
}).catch(() => { /* The first-pose image remains visible beneath the clear canvas. */ });
const environmentPreview = viewDemo.querySelector('.view-env');
connectTiles(viewDemo, 4, 384, time => {
  const frame = Math.min(450, Math.round(time * 25));
  const light = frame < 250 ? 'R05' : 'R06';
  if (environmentPreview.dataset.light !== light) {
    environmentPreview.src = 'media/viewpoint/' + light + '.jpg';
    environmentPreview.dataset.light = light;
  }
  drawTrajectory(frame < 250 ? Math.max(0, frame - 50) : frame - 250, light);
});
const streamClock = document.querySelector('#stream-clock');
streamClock.defaultPlaybackRate = 3;
streamClock.playbackRate = 3;
connectTiles(document.querySelector('.stream-demo'), 3, 480);
connectTiles(document.querySelector('#proxy-results'), 4, 480);
connectTiles(document.querySelector('#data-fixed'), 4, 480);
connectTiles(document.querySelector('#data-rotating'), 3, 480);

const subchapters = document.querySelector('#ablation-chapters');
const subchapterButtons = [...subchapters.querySelectorAll('[data-subchapter]')];
// Keep chapter links and seeking on the original timeline across both MP4 parts.
function filmTime() {
  return pendingChapter ?? (filmPart ? filmSplit : 0) + film.currentTime;
}
function revealFilm() {
  if (pendingChapter !== null || film.seeking || film.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  films.forEach(track => {
    track.classList.toggle('is-current', track === film);
    if (track === film) track.removeAttribute('aria-hidden');
    else track.setAttribute('aria-hidden', 'true');
  });
}
function loadFilm(track) {
  if (!track.hasAttribute('src')) track.src = track.dataset.src;
}
function bufferNextFilm() {
  if (filmPart || film.paused || filmSplit - film.currentTime > 20) return;
  const bufferedThrough = Math.min(filmSplit - .04, film.currentTime + 6);
  for (let i = 0; i < film.buffered.length; i++) {
    if (film.buffered.start(i) > film.currentTime || film.buffered.end(i) < bufferedThrough) continue;
    // Leave enough buffered for the active track before requesting the following one.
    const next = films[1];
    next.preload = 'auto';
    loadFilm(next);
    if (!next.seeking && next.currentTime > .04) next.currentTime = 0;
    break;
  }
}
function markChapter() {
  const time = filmTime();
  const active = chapters.filter(button => Number(button.dataset.chapter) <= time + .02).at(-1);
  subchapters.hidden = active?.getAttribute('aria-controls') !== subchapters.id;
  const currentSubchapter = subchapterButtons.filter(button => Number(button.dataset.subchapter) <= time + .02).at(-1);
  subchapterButtons.forEach(button => {
    if (!subchapters.hidden && time < 165.04 && button === currentSubchapter) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  });
  chapters.forEach(button => {
    if (button === active) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  });
}
function applyChapter() {
  if (pendingChapter === null || film.readyState < HTMLMediaElement.HAVE_METADATA) return;
  const time = pendingChapter - (filmPart ? filmSplit : 0);
  if (Math.abs(film.currentTime - time) > .015) film.currentTime = time;
  pendingChapter = null;
  markChapter();
  revealFilm();
}
function seekFilm(seconds, play = !film.paused) {
  pendingChapter = Math.max(0, Math.min(seconds, filmDuration - .04));
  const nextPart = pendingChapter < filmSplit ? 0 : 1;
  if (filmPart !== nextPart) {
    film.pause();
    filmPart = nextPart;
    film = films[filmPart];
  }
  loadFilm(film);
  applyChapter();
  markChapter();
  if (play) film.play().catch(() => {});
}
films.forEach(track => {
  track.addEventListener('loadedmetadata', () => { if (track === film) applyChapter(); });
  ['loadeddata', 'seeked', 'playing'].forEach(event => {
    track.addEventListener(event, () => { if (track === film) revealFilm(); });
  });
  track.addEventListener('timeupdate', () => {
    if (track !== film) return;
    markChapter();
    bufferNextFilm();
  });
  track.addEventListener('ended', () => {
    if (track === film && screening.open) seekFilm(filmPart ? 0 : filmSplit, true);
  });
});
document.querySelectorAll('[data-film]').forEach(link => link.addEventListener('click', event => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || typeof screening.showModal !== 'function') return;
  event.preventDefault();
  filmTrigger = link;
  screening.showModal();
  document.body.style.overflow = 'hidden';
  syncVisibleLoops();
  seekFilm(Number(link.dataset.film), true);
}));
[...chapters, ...subchapterButtons].forEach(button => button.addEventListener('click', () => seekFilm(Number(button.dataset.chapter ?? button.dataset.subchapter), true)));
document.querySelector('#close-film').addEventListener('click', () => screening.close());
screening.addEventListener('click', event => {
  if (event.target !== screening) return;
  const rect = screening.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) screening.close();
});
screening.addEventListener('close', () => {
  film.pause();
  pendingChapter = null;
  document.body.style.overflow = '';
  filmTrigger?.focus({ preventScroll: true });
  syncVisibleLoops();
});

const menuToggle = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#main-nav');
function setMenu(open) {
  navigation.classList.toggle('is-open', open);
  menuToggle.setAttribute('aria-expanded', String(open));
  menuToggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
}
menuToggle.addEventListener('click', () => setMenu(menuToggle.getAttribute('aria-expanded') !== 'true'));
navigation.addEventListener('click', () => setMenu(false));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menuToggle.getAttribute('aria-expanded') === 'true') {
    setMenu(false);
    menuToggle.focus();
  }
});
document.addEventListener('click', event => {
  if (!navigation.contains(event.target) && !menuToggle.contains(event.target)) setMenu(false);
});

// Keep seeking and full-screen viewing independent of playback.
const playbar = document.querySelector('#playbar-template');
document.querySelectorAll('.clip-player').forEach(player => {
  player.append(playbar.content.cloneNode(true));
  const seek = player.querySelector('.play-seek');
  const clock = player.querySelector('.play-clock');
  const expand = player.querySelector('.expand-video');

  function showTime() {
    const time = filmTime();
    seek.disabled = false;
    seek.max = filmDuration - .04;
    seek.value = time;
    const seconds = Math.floor(time);
    clock.value = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    seek.setAttribute('aria-valuetext', clock.value);
  }
  films.forEach(track => {
    track.addEventListener('loadedmetadata', () => { if (track === film) showTime(); });
    track.addEventListener('timeupdate', () => { if (track === film) showTime(); });
  });
  showTime();
  seek.addEventListener('input', () => seekFilm(Number(seek.value)));

  function updateExpandLabel() {
    const expanded = document.fullscreenElement === player || player.classList.contains('expanded');
    expand.title = expanded ? 'Exit full screen' : 'Full screen';
    expand.setAttribute('aria-label', expand.title);
  }
  expand.addEventListener('click', async () => {
    if (document.fullscreenElement === player) await document.exitFullscreen();
    else if (player.classList.contains('expanded')) player.classList.remove('expanded');
    else {
      try { await player.requestFullscreen(); }
      catch { player.classList.add('expanded'); }
    }
    updateExpandLabel();
  });
  document.addEventListener('fullscreenchange', updateExpandLabel);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && player.classList.contains('expanded')) {
      event.preventDefault();
      player.classList.remove('expanded');
      updateExpandLabel();
      expand.focus();
    }
  });
});
