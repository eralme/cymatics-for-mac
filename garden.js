// Live Resonance Garden for the homepage hero. It runs the lab's circular wave model (garden-model.js) on a slow
// C, Am, F, G progression played with the lab's harmonic tone. The captured image stays underneath: nothing is
// drawn when motion is reduced, data saving is on, WebGL2 is missing, or anything fails.
import { MAX_PIXELS, createGarden } from './garden-model.js';

const HOLD = 9, // seconds on each chord
  FADE = 3, // seconds of dissolve into the next chord
  FPS = 30,
  SLOW = 0.25; // the model's audio clock runs at a quarter of real time, so the field drifts rather than churns
// MIDI notes, voice-led around middle C: C4 E4 G4, C4 E4 A4, C4 F4 A4, B3 D4 G4.
const CHORDS = [
  [60, 64, 67],
  [60, 64, 69],
  [60, 65, 69],
  [59, 62, 67],
];
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));

function start() {
  const figure = document.querySelector('.hero-art'),
    image = figure?.querySelector('img.garden');
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  if (!image || still.matches || navigator.connection?.saveData) return;
  const canvas = document.createElement('canvas');
  const garden = createGarden(canvas, CHORDS);
  if (!garden) return;

  const built = new Set([0]);
  let clock = 0,
    last = 0,
    frame = 0,
    onScreen = false,
    pending = false,
    stopped = false;
  function draw() {
    const period = HOLD + FADE,
      c = Math.floor(clock / period) % CHORDS.length,
      next = (c + 1) % CHORDS.length,
      into = clock % period;
    const t = clamp((into - HOLD) / FADE),
      mix = t * t * (3 - 2 * t);
    // Level breathes with each phrase.
    garden.draw(clock * SLOW, c, next, mix, 0.16 + 0.025 * Math.cos((2 * Math.PI * into) / period));
    if (mix > 0) built.add(next);
    else if (!built.has(next) && !pending) {
      pending = true;
      (window.requestIdleCallback || setTimeout)(() => {
        garden.build(next);
        built.add(next);
        pending = false;
      });
    }
  }
  function stop() {
    stopped = true;
    cancelAnimationFrame(frame);
    figure.classList.remove('is-live');
    canvas.remove();
  }
  function tick(now) {
    frame = requestAnimationFrame(tick);
    if (now - last < 1000 / FPS - 2) return;
    clock += Math.min(0.1, (now - last) / 1000);
    last = now;
    try {
      draw();
      figure.classList.add('is-live');
    } catch {
      stop();
    }
  }
  function run() {
    cancelAnimationFrame(frame);
    if (stopped || !onScreen || document.hidden) return;
    last = performance.now();
    frame = requestAnimationFrame(tick);
  }
  function resize() {
    const pixels = Math.min(MAX_PIXELS, Math.round(canvas.clientWidth * Math.min(2, devicePixelRatio || 1)));
    if (pixels > 0 && pixels !== canvas.width) {
      canvas.width = canvas.height = pixels;
      if (!stopped) draw();
    }
  }

  canvas.className = 'garden-live';
  canvas.setAttribute('aria-hidden', 'true');
  garden.lost(stop);
  image.after(canvas);
  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(entries => {
    onScreen = entries[entries.length - 1].isIntersecting;
    run();
  }).observe(figure);
  document.addEventListener('visibilitychange', run);
  still.addEventListener('change', () => still.matches && stop());
}

try {
  start();
} catch {
  // The captured image stays in place.
}
