'use strict';

const split = document.querySelector('#light-split');
const stage = split.closest('.comparison-stage');

function updateComparison() {
  stage.style.setProperty('--split', split.value + '%');
  split.setAttribute('aria-valuetext', split.value + '% colonnade, ' + (100 - split.value) + '% evening street');
}
split.addEventListener('input', updateComparison);
updateComparison();
for (const control of document.querySelectorAll('.comparison [hidden]')) control.hidden = false;

const teaser = document.querySelector('#teaser');
const film = document.querySelector('#research-film');
const stills = [...document.querySelectorAll('[data-still]')];
const chapters = [...document.querySelectorAll('[data-chapter]')];
const pendingSeeks = new Map();

function setCurrent(links, current) {
  for (const link of links) {
    if (link === current) link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  }
}

function playVideo(video) {
  // Native controls remain available if a browser requires another tap to play.
  video.play()?.catch(() => {});
}

function applySeek(video) {
  if (!pendingSeeks.has(video) || video.readyState < HTMLMediaElement.HAVE_METADATA) return;
  video.currentTime = pendingSeeks.get(video);
  pendingSeeks.delete(video);
}

function seekTo(video, time, play) {
  pendingSeeks.set(video, time);
  if (!play) video.pause();
  // A paused player with preload="none" may fetch only metadata after a seek.
  video.preload = 'auto';
  if (video.error || (video.readyState === 0 && video.networkState !== HTMLMediaElement.NETWORK_LOADING)) video.load();
  applySeek(video);
  if (play) playVideo(video);
}

for (const video of [teaser, film]) {
  video.addEventListener('loadedmetadata', () => applySeek(video));
  video.addEventListener('play', () => (video === film ? teaser : film).pause());
}

function usualClick(event) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

for (const link of stills) {
  link.addEventListener('click', event => {
    if (!usualClick(event)) return;
    event.preventDefault();
    setCurrent(stills, link);
    seekTo(teaser, Number(link.dataset.still), false);
  });
}
teaser.addEventListener('play', () => setCurrent(stills, null));
teaser.addEventListener('seeked', () => {
  const selected = stills.find(link => link.hasAttribute('aria-current'));
  if (selected && Math.abs(teaser.currentTime - Number(selected.dataset.still)) > .15) setCurrent(stills, null);
});

function markChapter() {
  const time = pendingSeeks.get(film) ?? film.currentTime;
  const active = chapters.filter(link => Number(link.dataset.chapter) <= time + .02).pop();
  setCurrent(chapters, active);
}
for (const link of chapters) {
  link.addEventListener('click', event => {
    if (!usualClick(event)) return;
    event.preventDefault();
    seekTo(film, Number(link.dataset.chapter), true);
    markChapter();
    if (film.getBoundingClientRect().bottom <= 0) film.scrollIntoView({block:'start'});
  });
}
film.addEventListener('timeupdate', markChapter);
film.addEventListener('seeked', markChapter);
document.querySelector('#watch-film').addEventListener('click', event => {
  if (usualClick(event)) playVideo(film);
});
