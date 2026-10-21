// The lab's circular wave model (preview/part-nature.js: nrRatio, nrPrepare, nrBesselInto and the WebGL2 field
// shader), shared by the homepage's live Garden (garden.js) and the marketing videos (marketing/ad). createGarden()
// sets it up on a canvas for a list of chords; the caller owns the clock, so a page can run it on
// requestAnimationFrame and a video renderer frame by frame.
const DOMAIN = 4,
  SPEED = 343,
  TIME = 512,
  PEAKS = 6,
  GOLDEN = Math.PI * (3 - Math.sqrt(5));
// The lab's High tier, as captured in assets/resonance-garden.jpg: it sets the alias cutoff and the gradient scale.
const GRID = 160,
  RADIAL = 768,
  MEAN_GRID = 96;
// The largest canvas side the homepage draws, in device pixels.
export const MAX_PIXELS = 1200;
const HARMONY = 80; // fixed coherence input; the lab measures it from the audio
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const hz = midi => 440 * Math.pow(2, (midi - 69) / 12);

// The lab's Interval Lab tone (tonePartials and mergePeaks): partials n = 1 to 6 at amplitude 1/n.
function chordPeaks(notes) {
  const list = notes.flatMap(note => [1, 2, 3, 4, 5, 6].map(n => ({ f: hz(note) * n, a: 1 / n }))).sort((a, b) => a.f - b.f);
  const out = [];
  for (const p of list) {
    const last = out[out.length - 1];
    if (last && Math.abs(p.f - last.f) < 0.01) last.a += p.a;
    else out.push({ ...p });
  }
  return out;
}

function ratioOf(r) {
  let best = null,
    cost = Infinity;
  for (let q = 1; q <= 12; q++)
    for (let p = q; p <= 24; p++) {
      let a = p,
        b = q;
      while (b) [a, b] = [b, a % b];
      if (a !== 1) continue;
      const error = Math.abs(1200 * Math.log2((r * q) / p)),
        score = Math.log2(p * q) + error / 10;
      if (error <= 20 && score < cost) {
        best = { p, q };
        cost = score;
      }
    }
  return best;
}

function prepare(peaks, maxHz) {
  const top = peaks
    .filter(p => p.f < maxHz)
    .sort((a, b) => b.a - a.a || a.f - b.f)
    .slice(0, PEAKS);
  const f0 = Math.min(...top.map(p => p.f));
  return top.map((p, j) => {
    const ratio = ratioOf(p.f / f0),
      edge = clamp((maxHz - p.f) / (0.15 * maxHz));
    return {
      f: p.f,
      a: p.a * edge * edge * (3 - 2 * edge),
      k: (2 * Math.PI * p.f) / SPEED,
      m: ratio ? Math.min(12, ratio.p + ratio.q) : Math.min(12, 1 + Math.floor(6 * Math.log2(p.f / f0))),
      phi: j * GOLDEN + 2 * Math.PI * Math.log2(p.f / f0),
    };
  });
}

// Miller's downward recurrence for J0, Jm, Jm+1 and J1 at x >= 0, normalised by J0 + 2(J2 + J4 + ...) = 1.
function bessel(x, m, out) {
  if (x < 1e-12) {
    out[0] = 1;
    out[1] = m === 0 ? 1 : 0;
    out[2] = out[3] = 0;
    return;
  }
  const last = Math.max(m + 32, Math.ceil(x) + 32),
    twoOverX = 2 / x;
  let next = 0,
    current = 1,
    total = 0,
    jm = 0,
    jp = 0,
    j0 = 0,
    j1 = 0;
  for (let n = last; n > 0; n--) {
    const previous = n * twoOverX * current - next;
    next = current;
    current = previous;
    if (Math.abs(current) > 1e100) {
      current *= 1e-100;
      next *= 1e-100;
      total *= 1e-100;
      jm *= 1e-100;
      jp *= 1e-100;
      j1 *= 1e-100;
    }
    const order = n - 1;
    if (order === m) jm = current;
    if (order === m + 1) jp = current;
    if (order === 0) j0 = current;
    if (order === 1) j1 = current;
    if (order > 0 && !(order & 1)) total += current;
  }
  const scale = 1 / (j0 + 2 * total);
  out[0] = j0 * scale;
  out[1] = jm * scale;
  out[2] = jp * scale;
  out[3] = j1 * scale;
}

// The lab's per-pixel field shader. Changes: a row offset into one table for all chords, a field origin inside
// the canvas, and a weight so two chords can dissolve additively over the cleared background.
const FRAGMENT = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D radial; uniform vec2 size, origin; uniform int count, row;
uniform vec4 waves[6]; uniform vec2 phases[6];
uniform float meanEnergy, coherence, gain, referenceStep, weight;
out vec4 color;
vec4 bessel(float r, int j) {
  float at = clamp(r*768.0,0.0,767.9999); int lo = int(floor(at));
  return mix(texelFetch(radial,ivec2(lo,row+j),0),texelFetch(radial,ivec2(lo+1,row+j),0),fract(at));
}
void main() {
  vec2 p = ((gl_FragCoord.xy-origin)/size-0.5)*4.0; p.y = -p.y;
  float r = length(p), rho = r*0.5;
  if (rho>=1.0 || gain<=0.0 || meanEnergy<=0.0) { color=vec4(0.0); return; }
  float theta=r>0.00001 ? atan(p.y,p.x) : 0.0, safeR=max(r,0.00001);
  vec2 direction=p/safeR, psi=vec2(0.0), dr=vec2(0.0), da=vec2(0.0);
  float incoherent=0.0, idr=0.0, ida=0.0;
  for(int j=0;j<6;j++) {
    if(j>=count) break;
    float a=waves[j].x, m=waves[j].y, phi=waves[j].z, k=waves[j].w;
    vec4 b=bessel(rho,j);
    float z=max(k*r,0.00001), c=cos(m*theta-phi), s=sin(m*theta-phi);
    float cn=cos((m+1.0)*theta-phi), sn=sin((m+1.0)*theta-phi);
    vec2 v=a*vec2(b.y*c+0.24*b.x,b.z*sn);
    vec2 vr=a*k*vec2((m*b.y/z-b.z)*c-0.24*b.w,(b.y-(m+1.0)*b.z/z)*sn);
    vec2 va=a*vec2(-m*b.y*s,(m+1.0)*b.z*cn);
    mat2 rotate=mat2(phases[j].x,phases[j].y,-phases[j].y,phases[j].x);
    psi+=rotate*v; dr+=rotate*vr; da+=rotate*va;
    incoherent+=dot(v,v); idr+=2.0*dot(v,vr); ida+=2.0*dot(v,va);
  }
  float e=(coherence*dot(psi,psi)+(1.0-coherence)*incoherent)/meanEnergy;
  float er=(2.0*coherence*dot(psi,dr)+(1.0-coherence)*idr)/meanEnergy;
  float ea=(2.0*coherence*dot(psi,da)+(1.0-coherence)*ida)/meanEnergy;
  vec2 gradient=vec2(direction.x*er-direction.y*ea/safeR,direction.y*er+direction.x*ea/safeR)*referenceStep*2.0;
  float slope=length(gradient), width=0.025+min(0.09,slope*0.085);
  vec3 d=vec3((e-0.38)/width,(e-1.12)/(width*1.35),(e-2.05)/(width*1.5));
  float filament=dot(exp(-d*d),vec3(1.0,0.72,0.32));
  float light=clamp(0.58-0.45*(gradient.x+gradient.y)/sqrt(1.0+slope*slope),0.15,1.0);
  float wash=min(0.18,sqrt(max(0.0,e))*0.07), detail=min(1.2,filament*(0.5+light*0.55));
  float h=clamp((coherence-0.2)/0.8,0.0,1.0)*(0.3+0.7*clamp(e/2.0,0.0,1.0)), hot=min(1.0,detail*detail);
  vec3 ink=vec3(42.0+143.0*h,152.0+30.0*h,184.0-86.0*h)*detail+vec3(58.0,62.0,82.0)*hot+vec3(24.0,92.0,154.0)*wash;
  float aperture=pow(max(0.0,1.0-pow(rho,8.0)),2.0);
  color=vec4(min(vec3(244.0,240.0,232.0),ink*gain*aperture)*weight/255.0,1.0);
}`;

function program(gl) {
  const compile = (kind, source) => {
    const shader = gl.createShader(kind);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
  };
  const vs = compile(gl.VERTEX_SHADER, '#version 300 es\nin vec2 position; void main() { gl_Position = vec4(position,0.0,1.0); }');
  const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT);
  if (!vs || !fs) return null;
  const linked = gl.createProgram();
  gl.attachShader(linked, vs);
  gl.attachShader(linked, fs);
  gl.linkProgram(linked);
  return gl.getProgramParameter(linked, gl.LINK_STATUS) ? linked : null;
}

// draw(time, c, next, mix, level) renders chord c dissolving into chord next by mix (0 to 1) at model time `time`,
// with level as an RMS-like loudness. build(c) prepares a chord ahead of time, as building it costs a few frames.
// Returns null when WebGL2 or the shader is unavailable, so a page can keep its captured image.
export function createGarden(canvas, chords, { preserveDrawingBuffer = false } = {}) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'low-power',
    preserveDrawingBuffer,
  });
  const linked = gl && program(gl);
  if (!linked) return null;
  gl.useProgram(linked);
  const u = {};
  for (const name of ['size', 'origin', 'count', 'row', 'waves', 'phases', 'meanEnergy', 'coherence', 'gain', 'referenceStep', 'weight'])
    u[name] = gl.getUniformLocation(linked, name);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(linked, 'position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  for (const [key, value] of [
    [gl.TEXTURE_MIN_FILTER, gl.NEAREST],
    [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
    [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
  ])
    gl.texParameteri(gl.TEXTURE_2D, key, value);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, RADIAL + 1, PEAKS * chords.length);
  gl.uniform1f(u.referenceStep, DOMAIN / (GRID - 1));
  gl.uniform1f(u.coherence, 0.2 + 0.8 * clamp(HARMONY / 100));
  gl.clearColor(11 / 255, 15 / 255, 23 / 255, 1);
  gl.blendFunc(gl.ONE, gl.ONE);
  gl.enable(gl.BLEND);

  // The lab normalises energy by its mean over the disk, computed on a CPU grid each frame.
  const R = DOMAIN / 2,
    step = DOMAIN / (MEAN_GRID - 1),
    cells = [];
  for (let y = 0; y < MEAN_GRID; y++)
    for (let x = 0; x < MEAN_GRID; x++) {
      const px = x * step - R,
        py = y * step - R,
        r = Math.hypot(px, py);
      if (r < R) cells.push({ index: Math.min(RADIAL - 1e-4, (r / R) * RADIAL), theta: Math.atan2(py, px) });
    }
  const models = [],
    tmp = new Float64Array(4),
    maxHz = (SPEED * (GRID - 1)) / (4 * DOMAIN);
  function build(c) {
    if (models[c]) return models[c];
    const waves = prepare(chordPeaks(chords[c]), maxHz),
      table = new Float32Array((RADIAL + 1) * 4 * PEAKS);
    const re = waves.map(() => new Float32Array(cells.length)),
      im = waves.map(() => new Float32Array(cells.length)),
      base = new Float32Array(cells.length);
    waves.forEach((w, j) => {
      const row = table.subarray(j * (RADIAL + 1) * 4, (j + 1) * (RADIAL + 1) * 4);
      for (let r = 0; r <= RADIAL; r++) {
        bessel((w.k * R * r) / RADIAL, w.m, tmp);
        row.set(tmp, r * 4);
      }
      cells.forEach((cell, i) => {
        const r0 = cell.index | 0,
          f = cell.index - r0,
          at = r0 * 4;
        const j0 = row[at] + f * (row[at + 4] - row[at]),
          jm = row[at + 1] + f * (row[at + 5] - row[at + 1]),
          jn = row[at + 2] + f * (row[at + 6] - row[at + 2]);
        re[j][i] = w.a * (jm * Math.cos(w.m * cell.theta - w.phi) + 0.24 * j0);
        im[j][i] = w.a * jn * Math.sin((w.m + 1) * cell.theta - w.phi);
        base[i] += re[j][i] ** 2 + im[j][i] ** 2;
      });
    });
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, c * PEAKS, RADIAL + 1, waves.length, gl.RGBA, gl.FLOAT, table);
    const values = new Float32Array(PEAKS * 4);
    waves.forEach((w, j) => values.set([w.a, w.m, w.phi, w.k], j * 4));
    return (models[c] = { c, waves, re, im, base, values, phases: new Float32Array(PEAKS * 2) });
  }

  function field(model, time, gain, weight) {
    const { waves, re, im, base, phases } = model,
      coherence = 0.2 + 0.8 * clamp(HARMONY / 100);
    waves.forEach((w, j) => {
      const phase = (-2 * Math.PI * w.f * time) / TIME;
      phases[j * 2] = Math.cos(phase);
      phases[j * 2 + 1] = Math.sin(phase);
    });
    let mean = 0;
    for (let i = 0; i < base.length; i++) {
      let real = 0,
        imaginary = 0;
      for (let j = 0; j < waves.length; j++) {
        const a = re[j][i],
          b = im[j][i],
          c = phases[j * 2],
          s = phases[j * 2 + 1];
        real += a * c - b * s;
        imaginary += a * s + b * c;
      }
      mean += Math.max(0, coherence * (real * real + imaginary * imaginary) + (1 - coherence) * base[i]);
    }
    gl.uniform1i(u.row, model.c * PEAKS);
    gl.uniform1i(u.count, waves.length);
    gl.uniform4fv(u.waves, model.values);
    gl.uniform2fv(u.phases, phases);
    gl.uniform1f(u.meanEnergy, mean / base.length);
    gl.uniform1f(u.gain, gain);
    gl.uniform1f(u.weight, weight);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  function draw(time, c, next, mix, level) {
    const size = canvas.width,
      span = Math.round(size * 0.96),
      origin = Math.floor((size - span) / 2);
    // The lab maps RMS level to gain = 1 - e^(-12 RMS).
    const gain = 1 - Math.exp(-12 * level);
    gl.viewport(0, 0, size, size);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport(origin, origin, span, span);
    gl.uniform2f(u.size, span, span);
    gl.uniform2f(u.origin, origin, origin);
    if (mix < 1) field(build(c), time, gain, 1 - mix);
    if (mix > 0) field(build(next), time, gain, mix);
  }

  build(0);
  return { draw, build, lost: listener => canvas.addEventListener('webglcontextlost', listener) };
}
