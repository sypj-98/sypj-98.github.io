'use strict';

const screening = document.querySelector('#screening');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const previewToggles = document.querySelectorAll('.preview-toggle');
let activePreview = null;
let warmPreview = null;
const previewViews = new Map();
let prefersReducedMotion = reducedMotion.matches;
let previewsEnabled = !prefersReducedMotion;
let pendingVisibilityCheck = 0;
let lastScrollY = window.scrollY;
let direction = 1;
let navigationTarget = null;

function releaseLoadingTrack(track) {
  const group = previewViews.get(track).group;
  if (group) {
    group.stop(true);
    return;
  }
  if (!track.hasAttribute('src') || (track.networkState !== HTMLMediaElement.NETWORK_LOADING && track.readyState > 0)) return;
  if (track.readyState >= HTMLMediaElement.HAVE_METADATA) previewViews.get(track).resumeAt = track.currentTime;
  track.removeAttribute('src');
  track.preload = 'none';
  track.load();
}

function attachPreview(video) {
  if (!video.hasAttribute('src')) video.src = video.dataset.src;
}

function playPreview(video) {
  const group = previewViews.get(video).group;
  if (group) {
    group.start();
    return;
  }
  video.preload = 'auto';
  attachPreview(video);
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
      const group = previewViews.get(activePreview).group;
      if (group) {
        group.stop(activePreview !== neighbor);
      } else {
        activePreview.pause();
        if (activePreview !== neighbor && (previewsEnabled || activePreview.readyState < HTMLMediaElement.HAVE_CURRENT_DATA)) {
          releaseLoadingTrack(activePreview);
        }
      }
    }
    activePreview = next;
    if (next) {
      const preview = previewViews.get(next);
      preview.retried = false;
      if (preview.rewind) {
        preview.resumeAt = 0;
        if (preview.group) preview.group.rewind();
        else if (next.readyState >= HTMLMediaElement.HAVE_METADATA) next.currentTime = 0;
        preview.rewind = false;
      }
      playPreview(next);
    }
  }
  if (neighbor) {
    // WebKit may fetch the entire neighboring file with auto. Reserve bandwidth for the visible motion.
    const preload = !next || hasPlaybackBuffer(next) ? 'auto' : 'metadata';
    if (neighbor.preload !== preload) neighbor.preload = preload;
    attachPreview(neighbor);
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
  const preview = { view, restartOnExit, rewind: false, resumeAt: 0, retried: false };
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
  video.addEventListener('error', () => {
    if (preview.group || preview.retried || activePreview !== video) return;
    preview.retried = true;
    setTimeout(() => {
      if (!video.error || activePreview !== video) return;
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
const updateMotion = event => {
  prefersReducedMotion = event.matches;
  setPreviewsEnabled(!prefersReducedMotion);
};
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
connectOriginalTiles(methodView, 510, time => {
  let stage = 'inputs';
  if (time >= 3.6 && time < 6.4) stage = 'buffers';
  if (time >= 6.4 && time < 19.6) stage = 'relit';
  setMethodStage(stage);
}, true);
methodView.addEventListener('error', event => {
  if (event.target instanceof HTMLVideoElement && !methodView.classList.contains('frame-ready')) setMethodStage('relit');
}, true);

// Use the delivered H.264 tracks directly so every tile retains its original pixels and color metadata.
function connectOriginalTiles(view, frameCount, update, restartOnExit = false) {
  const tracks = [...view.querySelectorAll('video[data-slots]')].map(video => ({
    video,
    count: Number(video.dataset.frames) || frameCount,
    confirmed: -1,
    tiles: video.dataset.slots.split(' ').map(slot =>
      view.querySelector(`[data-slot="${slot}"] canvas`).getContext('2d', { alpha: false }))
  }));
  const primary = tracks[0].video;
  let frame = 0;
  let run = null;
  let timer;
  let retried = false;

  function decode(track, index, signal) {
    const { video } = track;
    if (track.confirmed === index && !video.seeking && video.readyState >= 2) return;
    return new Promise((resolve, reject) => {
      let requested = false;
      function finish(error) {
        video.removeEventListener('loadedmetadata', seek);
        video.removeEventListener('loadeddata', ready);
        video.removeEventListener('seeked', ready);
        video.removeEventListener('error', fail);
        signal.removeEventListener('abort', cancel);
        if (error) reject(error);
        else {
          track.confirmed = index;
          resolve();
        }
      }
      function ready() {
        if (requested && !video.seeking && video.readyState >= 2) finish();
      }
      function seek() {
        track.confirmed = -1;
        requested = true;
        // Seek inside the frame interval. Rounded currentTime readings are unreliable on privacy-preserving browsers.
        video.currentTime = (index + .25) / 25;
      }
      const cancel = () => finish(new DOMException('Preview paused', 'AbortError'));
      const fail = () => finish(video.error || new Error('Video failed to decode'));
      video.addEventListener('loadedmetadata', seek);
      video.addEventListener('loadeddata', ready);
      video.addEventListener('seeked', ready);
      video.addEventListener('error', fail);
      signal.addEventListener('abort', cancel, { once: true });
      video.preload = 'auto';
      if (video.error) finish(video.error);
      else if (!video.hasAttribute('src')) video.src = video.dataset.src;
      else if (video.readyState >= 1) seek();
    });
  }

  async function next(current, due) {
    try {
      // The shorter fixed-light example repeats nine evenly spaced frames across the 202-frame rotating example.
      await Promise.all(tracks.map(track =>
        decode(track, Math.round(frame * (track.count - 1) / (frameCount - 1)), current.signal)));
      // WebKit may publish the canvas texture one refresh after seeked. Wait for that paint before reading it.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    } catch {
      if (current.signal.aborted) return;
      stop(true);
      if (!retried && activePreview === primary) {
        retried = true;
        timer = setTimeout(start, 1000);
      }
      return;
    }
    if (current.signal.aborted || activePreview !== primary) return;
    // All crops commit in one browser task. A slow or failed track leaves the last complete frame visible.
    for (const { video, tiles } of tracks) {
      const size = video.videoHeight;
      tiles.forEach((ctx, column) => blit(ctx, video, column * size, 0, size));
    }
    if (update) update(frame / 25);
    view.classList.add('frame-ready');
    retried = false;
    frame = (frame + 1) % frameCount;
    const nextDue = Math.max(performance.now(), due + 40);
    timer = setTimeout(() => next(current, nextDue), Math.max(0, nextDue - performance.now()));
  }

  function start() {
    if (run || activePreview !== primary) return;
    run = new AbortController();
    next(run, performance.now());
  }
  function stop(release = false) {
    run?.abort();
    run = null;
    clearTimeout(timer);
    for (const track of tracks) {
      const { video } = track;
      if (!video.hasAttribute('src') || (!release && (video === primary || video.networkState !== HTMLMediaElement.NETWORK_LOADING))) continue;
      track.confirmed = -1;
      video.removeAttribute('src');
      video.preload = 'none';
      video.load();
    }
  }
  function rewind() {
    if (run) stop();
    frame = 0;
  }
  window.addEventListener('online', () => {
    if (activePreview === primary && !run) {
      clearTimeout(timer);
      retried = false;
      start();
    }
  });
  observeLoop(primary, view, restartOnExit);
  previewViews.get(primary).group = { start, stop, rewind };
}

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
const castCover = document.querySelector('#cast-cover');
const castShade = castGrid.querySelector('.cast-shade');
const castStill = document.querySelector('#cast-still');
let coverTimeout;
function showCastStill() {
  clearTimeout(coverTimeout);
  if (!castStill.isConnected) return;
  // Reuse the same lossless picture that a browser with scripting disabled displays.
  castStill.insertAdjacentHTML('beforebegin', castStill.textContent);
  castStill.remove();
}
function loadCastCover() {
  if (!previewsEnabled || !castCover.canPlayType('video/mp4')) return showCastStill();
  // One original H.264 keyframe is sufficient for a sharp, stationary poster.
  castCover.preload = 'auto';
  castCover.src = castCover.dataset.coverSrc;
  // Keep the keyframe request alive if the static fallback has to race it on a slow connection.
  coverTimeout = setTimeout(() => {
    if (castCover.readyState < 2 && !castView.classList.contains('frame-ready')) showCastStill();
  }, 2500);
}
castCover.addEventListener('loadeddata', () => clearTimeout(coverTimeout), { once:true });
castCover.addEventListener('error', showCastStill, { once:true });
if ('IntersectionObserver' in window) {
  const coverObserver = new IntersectionObserver(entries => {
    if (!entries[0].isIntersecting) return;
    coverObserver.disconnect();
    loadCastCover();
  }, { rootMargin:'900px 0px' });
  coverObserver.observe(castView);
} else loadCastCover();

// Only expose frames copied to this canvas: a native video can advance one paint ahead of its grid.
const castCanvas = castGrid.querySelector('.cast-frame');
const castContext = castCanvas.getContext('2d', { alpha:false });
const castCuts = [{ frame:114, from:3, to:5 }, { frame:297, from:5, to:7 }];
const castFps = 25;
let castFrame = -1;
let growingAfterLoop = false;
let castTween = 0;

function easeCast(value) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function layoutCast() {
  cancelAnimationFrame(castTween);
  if (castFrame < 0) return;
  const columns = castFrame < castCuts[0].frame ? 3 : castFrame < castCuts[1].frame ? 5 : 7;
  const length = Math.round(castClock.duration * castFps);
  // Interpolate within the displayed sample. Only a decoded frame can advance the grid to its next density.
  const position = Math.max(castFrame, Math.min(castFrame + 1, castClock.currentTime * castFps));
  let scale = 1;
  let shade = 0;
  let inset = 0;
  if (!prefersReducedMotion) {
    for (const cut of castCuts) {
      const offset = position - cut.frame;
      const ratio = cut.from / cut.to;
      if (columns === cut.from && offset >= -18) scale = 1 - (1 - ratio) * easeCast((offset + 18) / 18);
      if (columns === cut.to && offset >= 0 && offset < 9) {
        inset = (1 - ratio) * 50;
        shade = 1 - easeCast(offset / 9);
      }
    }
    if (columns === 7 && position >= length - 10) {
      inset = (1 - 3 / 7) * 50;
      shade = easeCast((position - length + 10) / 9);
    } else if (growingAfterLoop) {
      scale = 3 / 7 + (1 - 3 / 7) * easeCast(position / 18);
    }
  }
  castGrid.style.setProperty('--columns', columns);
  castGrid.style.setProperty('--cast-half-gap', 1.5 / scale + 'px');
  castGrid.style.transform = scale === 1 ? '' : 'scale(' + scale + ')';
  castShade.style.inset = inset + '%';
  castShade.style.opacity = shade;
  if ((scale < 1 || shade > 0) && !castClock.paused && activePreview === castClock && !document.hidden) {
    castTween = requestAnimationFrame(layoutCast);
  }
}

function drawCast(time) {
  const frame = Math.floor(time * castFps + .0001);
  const length = Math.round(castClock.duration * castFps);
  if (frame < 18 && castFrame >= length - 10) growingAfterLoop = true;
  if (frame >= 18) growingAfterLoop = false;
  castFrame = frame;
  castContext.drawImage(castClock, 0, 0);
  // The original loop cuts between lighting setups. Dissolve the central nine into the exact opening pose.
  if (frame >= length - 10 && !prefersReducedMotion) {
    const cover = castCover.readyState >= 2 ? castCover : castGrid.querySelector('img.cast-poster');
    if (cover === castCover || cover?.naturalWidth) {
      const tile = castCanvas.width / 7;
      castContext.globalAlpha = easeCast((frame - length + 10) / 9);
      castContext.drawImage(cover, tile * 2, tile * 2, tile * 3, tile * 3);
      castContext.globalAlpha = 1;
    }
  }
  layoutCast();
}
function resetCastPoster() {
  cancelAnimationFrame(castTween);
  castFrame = -1;
  growingAfterLoop = false;
  castGrid.removeAttribute('style');
  castShade.removeAttribute('style');
  castView.classList.remove('frame-ready');
}
castClock.addEventListener('emptied', resetCastPoster);
castClock.addEventListener('error', resetCastPoster);
reducedMotion.addEventListener?.('change', layoutCast);
if (castContext) observeFrames(castClock, castView, drawCast);
else showCastStill();

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
const referenceCue = environmentPreview.querySelector('.view-reference');
const viewClock = viewDemo.querySelector('#view-clock');
const viewFps = 25;
const firstOrbitFrame = 50;
const secondOrbitFrame = 250;
// The film introduces the reference portraits once. Subsequent laps alternate the two lit orbits.
viewClock.addEventListener('ended', () => {
  viewClock.currentTime = firstOrbitFrame / viewFps;
  if (activePreview === viewClock) playPreview(viewClock);
});
connectTiles(viewDemo, 4, 384, time => {
  const frame = Math.min(450, Math.floor(time * viewFps + .0001));
  const light = frame < secondOrbitFrame ? 'R05' : 'R06';
  // Match the introduction and the hard lighting cut in the decoded portrait frame.
  const visibleLight = frame < 24 ? '' : light;
  if (environmentPreview.dataset.light !== visibleLight) environmentPreview.dataset.light = visibleLight;
  const fade = Math.max(0, Math.min(1, (frame - 23) / 23));
  referenceCue.hidden = fade === 1;
  environmentPreview.style.setProperty('--light-opacity', fade * fade * (3 - 2 * fade));
  drawTrajectory(frame < secondOrbitFrame ? Math.max(0, frame - firstOrbitFrame) : frame - secondOrbitFrame, light);
});
const streamClock = document.querySelector('#stream-clock');
const streamDemo = document.querySelector('.stream-demo');
streamClock.defaultPlaybackRate = 3;
streamClock.playbackRate = 3;
connectTiles(streamDemo, 3, 480);
connectTiles(document.querySelector('#proxy-results'), 4, 480);
// Both lighting conditions share the same decoded frame, including when only one row is visible.
connectOriginalTiles(document.querySelector('#hybrid-data'), 202);

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
