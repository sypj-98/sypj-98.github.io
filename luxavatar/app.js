'use strict';

const screening = document.querySelector('#screening');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const previewToggles = document.querySelectorAll('.preview-toggle');
let activePreview = null;
let warmPreview = null;
const previewViews = new Map();
let previewsEnabled = !reducedMotion.matches;
let pendingVisibilityCheck = 0;
let lastScrollY = window.scrollY;
let direction = 1;
let navigationTarget = null;

function releaseLoadingTrack(track) {
  if (!track.hasAttribute('src') || (track.networkState !== HTMLMediaElement.NETWORK_LOADING && track.readyState > 0)) return;
  if (track.readyState >= HTMLMediaElement.HAVE_METADATA) previewViews.get(track).resumeAt = track.currentTime;
  track.removeAttribute('src');
  track.preload = 'none';
  track.load();
}

function attachPreview(video, coldStart = false) {
  if (video.hasAttribute('src')) return;
  const network = navigator.connection;
  const slow = ['slow-2g', '2g', '3g'].includes(network?.effectiveType);
  const limited = network?.saveData || slow || (network?.downlink > 0 && network.downlink < 4.5);
  // The lighter files preserve the original pixel grid and timing. Safari exposes no link estimate.
  const useLight = video.dataset.light && (coldStart || network?.saveData || !network?.downlink ||
    network.downlink < Number(video.dataset.mbps) || slow);
  if (video.dataset.low && (limited || previewViews.get(video).constrained)) video.src = video.dataset.low;
  else video.src = useLight ? video.dataset.light : video.dataset.src;
}

function playPreview(video) {
  video.preload = 'auto';
  attachPreview(video, true);
  if (video.error) video.load();
  video.play().catch(error => {
    if (error.name === 'NotAllowedError' && activePreview === video) setPreviewsEnabled(false);
  });
}

function hasPlaybackBuffer(video) {
  const { buffered, currentTime, duration, playbackRate } = video;
  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= currentTime + .05 && buffered.end(i) >= Math.min(duration - .05, currentTime + 2.5 * playbackRate)) return true;
  }
  return false;
}

function syncVisibleLoops() {
  let next = null;
  let neighbor = null;
  const height = document.documentElement.clientHeight;
  const canPlay = previewsEnabled && !document.hidden && !screening.open;
  if (Math.abs(window.scrollY - lastScrollY) > 12) {
    direction = window.scrollY > lastScrollY ? 1 : -1;
    lastScrollY = window.scrollY;
  }
  if (canPlay) {
    let nearestCenter = Infinity;
    const boxes = new Map();
    for (const [video, preview] of previewViews) {
      const box = preview.view.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      boxes.set(video, box);
      const visible = Math.min(height, box.bottom) - Math.max(0, box.top);
      if (visible <= 0 && preview.restartOnExit) preview.rewind = true;
      if (visible < Math.min(64, Math.min(height, box.height) * .15)) continue;
      const distance = Math.max(0, box.top - height / 2, height / 2 - box.bottom);
      if (distance < nearestCenter) {
        nearestCenter = distance;
        next = video;
      }
    }
    // Prepare just the next exhibit in reading order, once the on-screen one has frames.
    if (!navigator.connection?.saveData) {
      const current = boxes.get(next);
      const edge = direction > 0 ? current?.bottom ?? 0 : current?.top ?? height;
      let nearest = Infinity;
      for (const [video, box] of boxes) {
        const gap = direction > 0 ? box.top - edge : edge - box.bottom;
        const ahead = direction > 0 ? box.top - height : -box.bottom;
        if (video !== next && gap >= -1 && ahead < height * 2 && gap < nearest) {
          nearest = gap;
          neighbor = video;
        }
      }
      if (neighbor !== warmPreview && next && next.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) neighbor = null;
    }
    // A chapter link can smoothly scroll past several videos before reaching its destination.
    if (navigationTarget && next !== navigationTarget) {
      next = null;
      neighbor = navigator.connection?.saveData ? null : navigationTarget;
    } else {
      navigationTarget = null;
    }
  } else {
    navigationTarget = null;
  }

  if (warmPreview && warmPreview !== neighbor && warmPreview !== next) releaseLoadingTrack(warmPreview);
  warmPreview = neighbor;
  if (activePreview !== next) {
    if (activePreview) {
      activePreview.pause();
      if (activePreview !== neighbor && (previewsEnabled || activePreview.readyState < HTMLMediaElement.HAVE_CURRENT_DATA)) {
        releaseLoadingTrack(activePreview);
      }
    }
    activePreview = next;
    if (next) {
      const preview = previewViews.get(next);
      preview.retried = false;
      if (preview.rewind) {
        preview.resumeAt = 0;
        if (next.readyState >= HTMLMediaElement.HAVE_METADATA) next.currentTime = 0;
        preview.rewind = false;
      }
      playPreview(next);
    }
  }
  if (neighbor) {
    // WebKit may fetch the entire neighboring file with auto. Reserve bandwidth for the visible motion.
    const preload = !next || hasPlaybackBuffer(next) ? 'auto' : 'metadata';
    if (neighbor.preload !== preload) neighbor.preload = preload;
    attachPreview(neighbor, neighbor === navigationTarget);
  }
}

function queueVisibilityCheck() {
  if (!pendingVisibilityCheck) pendingVisibilityCheck = requestAnimationFrame(() => {
    pendingVisibilityCheck = 0;
    syncVisibleLoops();
  });
}
const previewResize = window.ResizeObserver && new ResizeObserver(queueVisibilityCheck);
function observeLoop(video, view = video, restartOnExit = false) {
  const preview = { view, restartOnExit, rewind: false, resumeAt: 0, retried: false, frames: 0 };
  previewViews.set(video, preview);
  video.addEventListener('loadedmetadata', () => {
    if (!preview.rewind && preview.resumeAt > 0 && preview.resumeAt < video.duration) {
      video.currentTime = preview.resumeAt;
    }
    preview.resumeAt = 0;
  });
  video.addEventListener('loadeddata', queueVisibilityCheck);
  video.addEventListener('progress', () => {
    if (activePreview === video) queueVisibilityCheck();
  });
  // Link estimates can miss a slow CDN route. Recover at the same pose if playback remains starved.
  let stallTimer;
  const clearStall = () => clearTimeout(stallTimer);
  function watchForMotion() {
    clearStall();
    const fallback = video.dataset.low || video.dataset.light;
    if (!fallback || video.getAttribute('src') === fallback) return;
    const frames = preview.frames;
    stallTimer = setTimeout(() => {
      // Some engines fire playing while still presenting only the poster or first decoded frame.
      if (activePreview !== video || video.paused || preview.frames - frames >= 2 || video.seeking) return;
      if (video.currentTime > 0) preview.resumeAt = video.currentTime;
      preview.constrained = true;
      video.src = fallback;
      playPreview(video);
    }, 2200);
  }
  video.addEventListener('play', watchForMotion);
  video.addEventListener('waiting', watchForMotion);
  video.addEventListener('pause', clearStall);
  video.addEventListener('error', () => {
    if (preview.retried || activePreview !== video) return;
    preview.retried = true;
    setTimeout(() => {
      if (!video.error || activePreview !== video) return;
      if (video.dataset.light) {
        video.src = video.getAttribute('src') === video.dataset.light ? video.dataset.src : video.dataset.light;
      }
      playPreview(video);
    }, 1000);
  });
  previewResize?.observe(view);
  queueVisibilityCheck();
}

function setPreviewsEnabled(enabled) {
  previewsEnabled = enabled;
  document.documentElement.classList.toggle('previews-paused', !enabled);
  const label = enabled ? 'Pause previews' : 'Play previews';
  previewToggles.forEach(button => {
    button.hidden = false;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.querySelector('span').textContent = label;
  });
  syncVisibleLoops();
}
previewToggles.forEach(button => button.addEventListener('click', () => setPreviewsEnabled(!previewsEnabled)));
const updateMotion = event => setPreviewsEnabled(!event.matches);
if (reducedMotion.addEventListener) reducedMotion.addEventListener('change', updateMotion);
else reducedMotion.addListener(updateMotion);
setPreviewsEnabled(previewsEnabled);
window.addEventListener('scroll', queueVisibilityCheck, { passive: true });
window.addEventListener('resize', queueVisibilityCheck);
window.addEventListener('pageshow', queueVisibilityCheck);
document.addEventListener('visibilitychange', syncVisibleLoops);

function endNavigation() {
  if (!navigationTarget) return;
  navigationTarget = null;
  queueVisibilityCheck();
}
let navigationTimer;
document.querySelectorAll('#main-nav a, .head-inner .brand').forEach(link => link.addEventListener('click', event => {
  if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || !previewsEnabled) return;
  const video = document.getElementById(link.hash.slice(1))?.querySelector('video[data-src]');
  if (!previewViews.has(video)) return;
  navigationTarget = video;
  clearTimeout(navigationTimer);
  navigationTimer = setTimeout(endNavigation, 1800);
  syncVisibleLoops();
}));
window.addEventListener('wheel', endNavigation, { passive: true });
window.addEventListener('touchstart', endNavigation, { passive: true });

// One decoded video frame supplies every canvas in a comparison.
function connectPortraitPlayback(video, view, restartOnExit = false) {
  const panels = [...view.querySelectorAll('canvas')].map(canvas => ({
    canvas,
    panel: canvas.parentElement,
    context: canvas.getContext('2d', { alpha: false })
  }));
  function draw() {
    if (activePreview !== video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
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

  observeFrames(video, view, draw, restartOnExit);
  return draw;
}

// Use the decoded frame timestamp so tile layout and pixels change together on seeks and loops.
function observeFrames(video, view, paint, restartOnExit = false) {
  let callback = null;
  // At 3× playback, sampling at display refresh keeps frames that video callbacks skip.
  const useVideoFrameCallback = video.playbackRate <= 1 && video.requestVideoFrameCallback;
  function draw(time = video.currentTime) {
    if (activePreview !== video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    paint(time);
    const preview = previewViews.get(video);
    if (time !== preview.lastFrameTime) {
      preview.lastFrameTime = time;
      preview.frames++;
    }
    view.classList.add('frame-ready');
  }
  function queueFrame() {
    if (callback !== null || video.paused) return;
    const onFrame = (_, metadata) => {
      callback = null;
      draw(metadata?.mediaTime ?? video.currentTime);
      queueFrame();
    };
    callback = useVideoFrameCallback
      ? video.requestVideoFrameCallback(onFrame)
      : requestAnimationFrame(onFrame);
  }
  function cancelFrame() {
    if (callback === null) return;
    if (useVideoFrameCallback) video.cancelVideoFrameCallback(callback);
    else cancelAnimationFrame(callback);
    callback = null;
  }

  video.addEventListener('loadeddata', () => draw());
  video.addEventListener('seeked', () => draw());
  video.addEventListener('playing', () => { draw(); queueFrame(); });
  video.addEventListener('pause', cancelFrame);
  video.addEventListener('error', () => {
    cancelFrame();
    view.classList.remove('frame-ready');
  });
  observeLoop(video, view, restartOnExit);
}

connectPortraitPlayback(document.querySelector('#opening-film'), document.querySelector('.opening-panels'));
const methodView = document.querySelector('.method-demo');
const methodClock = methodView.querySelector('video');
const inputFigures = [...methodView.querySelectorAll('.method-inputs figure')];
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
// Update the stage only after all six crops of the same decoded frame are ready.
connectTiles(methodView, 3, 512, time => {
  let stage = 'inputs';
  if (time >= 3.6 && time < 6.4) stage = 'buffers';
  if (time >= 6.4 && time < 19.6) stage = 'relit';
  setMethodStage(stage);
}, true);
methodClock.addEventListener('error', () => setMethodStage('relit'));

// Pack unlabelled source portraits into a single stream per exhibit for frame-locked playback.
function blit(ctx, video, x, y, size) {
  const canvas = ctx.canvas;
  if (canvas.width !== size || canvas.height !== size) canvas.width = canvas.height = size;
  ctx.drawImage(video, x, y, size, size, 0, 0, size, size);
}
function connectTiles(view, columns, size, update, restartOnExit = false) {
  const video = view.querySelector('video');
  const tiles = [...view.querySelectorAll('[data-slot]')].map(tile => ({
    slot: Number(tile.dataset.slot),
    crop: Number(tile.dataset.size) || size,
    ctx: tile.querySelector('canvas').getContext('2d', { alpha: false })
  }));
  observeFrames(video, view, time => {
    // A crop may be smaller than its atlas cell when the source uses a different native size.
    const cell = video.videoWidth / columns;
    for (const { slot, ctx, crop } of tiles) {
      blit(ctx, video, slot % columns * cell, Math.floor(slot / columns) * cell, Math.round(crop * cell / size));
    }
    if (update) update(time);
  }, restartOnExit);
}
const castView = document.querySelector('.wall-screen');
const castGrid = castView.querySelector('.cast-grid');
const castClock = document.querySelector('#wall-film');
let castColumns = 3;
let previousCastFrame = null;
let castExpansion;

function interruptCastExpansion() {
  previousCastFrame = null;
  castExpansion?.cancel();
}
castClock.addEventListener('seeking', interruptCastExpansion);
castClock.addEventListener('pause', interruptCastExpansion);
function resetCastPoster() {
  interruptCastExpansion();
  castColumns = 3;
  castGrid.style.removeProperty('--columns');
  castView.classList.remove('frame-ready');
}
castClock.addEventListener('emptied', resetCastPoster);
castClock.addEventListener('error', resetCastPoster);
observeFrames(castClock, castView, time => {
  const frame = Math.round(time * 25);
  const columns = frame < 114 ? 3 : frame < 297 ? 5 : 7;
  if (columns !== castColumns) {
    castExpansion?.cancel();
    castGrid.style.setProperty('--columns', columns);
    // The existing faces occupy the center of the next packed layout. Start
    // at their previous size and reveal the new outer ring as the surface shrinks.
    if (previousCastFrame !== null && frame > previousCastFrame && columns === castColumns + 2
        && !reducedMotion.matches && !castClock.paused && !castClock.seeking) {
      castExpansion = castGrid.animate([
        { transform: `scale(${columns / castColumns})` },
        { transform: 'scale(1)' }
      ], { duration: 700, easing: 'ease' });
    }
    castColumns = columns;
  }
  previousCastFrame = frame;
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
const environmentPreview = viewDemo.querySelector('.view-light');
connectTiles(viewDemo, 4, 384, time => {
  const frame = Math.min(450, Math.round(time * 25));
  const light = frame < 250 ? 'R05' : 'R06';
  // The film holds the reference portraits, then fades in the first light and render together.
  const visibleLight = frame < 24 ? '' : light;
  if (environmentPreview.dataset.light !== visibleLight) environmentPreview.dataset.light = visibleLight;
  const fade = Math.max(0, Math.min(1, (frame - 23) / 23));
  const opacity = String(fade * fade * (3 - 2 * fade));
  if (environmentPreview.style.opacity !== opacity) environmentPreview.style.opacity = opacity;
  drawTrajectory(frame < 250 ? Math.max(0, frame - 50) : frame - 250, light);
});
const streamClock = document.querySelector('#stream-clock');
const streamDemo = document.querySelector('.stream-demo');
// Keep the matching inline still until its full-resolution replacement is decoded.
const exhibitPosters = new IntersectionObserver((entries, observer) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    observer.unobserve(entry.target);
    for (const preview of entry.target.querySelectorAll('img[data-full-src]')) {
      const original = preview.cloneNode(false);
      original.src = preview.dataset.fullSrc;
      original.removeAttribute('data-full-src');
      original.decode().then(() => preview.replaceWith(original)).catch(() => {
        // A failed JPEG leaves the complete inline image available.
      });
    }
  }
}, { rootMargin: '400px 0px' });
exhibitPosters.observe(environmentPreview);
exhibitPosters.observe(streamDemo);
streamClock.defaultPlaybackRate = 3;
streamClock.playbackRate = 3;
connectTiles(streamDemo, 3, 480);
connectTiles(document.querySelector('#proxy-results'), 4, 480);
// Both lighting conditions share the same decoded frame, including when only one row is visible.
connectTiles(document.querySelector('#hybrid-data'), 4, 480);

screening.addEventListener('filmopen', () => {
  syncVisibleLoops();
  // Pausing alone can leave range requests running while the film buffers.
  previewViews.forEach((_, video) => releaseLoadingTrack(video));
});
screening.addEventListener('close', syncVisibleLoops);

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
