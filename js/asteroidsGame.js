// ============================================================
// Asteroid Defense — a small personal arcade mini-game that runs
// entirely client-side. join.js drives it (starts/stops waves, handles
// shop purchases); the host never simulates any of this, since each
// student's world is private to them.
//
// Geometry is measured from the arena's actual rendered size at
// creation time (not a fixed pixel guess) — the CSS makes `.ast-arena`
// responsive (fills most of the available width, up to a cap), and
// this reads that real size back so the game genuinely fills whatever
// space it's given instead of being boxed into a small fixed square.
//
// Coordinate convention: everything is measured from the arena's
// center. `polarToXY(angleDeg, radius)` follows the same convention as
// the CSS `rotate(angleDeg) translateY(-radius)` trick used to position
// elements without manual trig in the DOM: 0° points straight up,
// positive degrees rotate clockwise.
// ============================================================

const MAX_WEAPONS = 8;
const MAX_WEAPON_LEVEL = 3;
const MAX_CONCURRENT_ASTEROIDS = 18;
const ROTATION_SPEED_DEG_PER_SEC = 150; // how fast the world spins while holding a side
const ASTEROID_EMOJIS = ['☄️', '🪨', '☄️'];

export const WEAPON_TYPES = {
  blaster: {
    key: 'blaster', name: 'Blaster', emoji: '🔫', cost: 50,
    baseFireRateMs: 1000, baseDamage: 1, rangeFraction: 0.55, arcDegrees: 10, homing: false, projectileMs: 220,
  },
  machinegun: {
    key: 'machinegun', name: 'Machine Gun', emoji: '⚙️', cost: 150,
    baseFireRateMs: 260, baseDamage: 1, rangeFraction: 0.65, arcDegrees: 12, homing: false, projectileMs: 180,
  },
  laser: {
    key: 'laser', name: 'Laser', emoji: '🔴', cost: 250,
    baseFireRateMs: 550, baseDamage: 2, rangeFraction: 0.8, arcDegrees: 8, homing: false, projectileMs: 90,
  },
  rocket: {
    key: 'rocket', name: 'Rocket Launcher', emoji: '🚀', cost: 400,
    baseFireRateMs: 2000, baseDamage: 4, rangeFraction: 1.0, arcDegrees: 360, homing: true, projectileMs: 420,
  },
};

export function upgradeCost(typeKey, currentLevel) {
  return Math.round(WEAPON_TYPES[typeKey].cost * 0.55 * currentLevel);
}

export function statsForLevel(typeKey, level) {
  const def = WEAPON_TYPES[typeKey];
  return {
    damage: Math.round(def.baseDamage * (1 + 0.35 * (level - 1))),
    fireRateMs: Math.round(def.baseFireRateMs * Math.pow(0.85, level - 1)),
  };
}

function polarToXY(angleDeg, radius) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: radius * Math.sin(rad), y: -radius * Math.cos(rad) };
}

function angleDiffDeg(a, b) {
  return Math.abs((((a - b + 540) % 360) + 360) % 360 - 180);
}

export function createAsteroidsGame(containerEl, callbacks = {}) {
  containerEl.innerHTML = `
    <div class="ast-arena" id="ast-arena">
      <div class="ast-rotor" id="ast-rotor">
        <div class="ast-world-sphere">🌍</div>
      </div>
    </div>
  `;
  const arenaEl = containerEl.querySelector('#ast-arena');
  const rotorEl = containerEl.querySelector('#ast-rotor');

  // Measure the actual rendered size (CSS sizes it responsively) so the
  // game genuinely fills the space it's given, on any device, rather
  // than being boxed into a fixed pixel guess that's wrong half the time.
  const arenaSize = arenaEl.getBoundingClientRect().width || 330;
  const CENTER = arenaSize / 2;
  const OUTER_RADIUS = arenaSize * 0.48; // spawn ring, right at the edge of the arena
  const INNER_RADIUS = arenaSize * 0.09; // world sphere — small, to maximize approach room
  const WEAPON_RING_RADIUS = arenaSize * 0.12;

  let weapons = [];
  let asteroids = [];
  let worldRotationDeg = 0;
  let waveActive = false;
  let waveNumber = 1;
  let spawnAccumulatorMs = 0;
  let spawnIntervalMs = 1200;
  let asteroidSpeed = 30;
  let asteroidMaxHp = 1;
  let earthHitThisWave = false;
  let asteroidsDestroyedTotal = 0;
  let nextAsteroidId = 0;
  let lastFrameTime = 0;
  let rafHandle = null;
  let dragging = false;
  let rotationDirection = 0; // -1 = counterclockwise (holding left side), +1 = clockwise (holding right side)

  // ---------------- rotation input ----------------
  // Touch/hold the left half of the arena to spin counterclockwise,
  // the right half to spin clockwise — continues for as long as it's
  // held, at a fixed speed, rather than tracking a drag distance.
  function directionFromEvent(e) {
    const rect = arenaEl.getBoundingClientRect();
    const midpointX = rect.left + rect.width / 2;
    return e.clientX < midpointX ? -1 : 1;
  }
  function onPointerDown(e) {
    dragging = true;
    rotationDirection = directionFromEvent(e);
    arenaEl.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e) {
    if (!dragging) return;
    rotationDirection = directionFromEvent(e); // let them slide their finger to switch sides mid-hold
  }
  function onPointerUp() {
    dragging = false;
    rotationDirection = 0;
  }
  arenaEl.addEventListener('pointerdown', onPointerDown);
  arenaEl.addEventListener('pointermove', onPointerMove);
  arenaEl.addEventListener('pointerup', onPointerUp);
  arenaEl.addEventListener('pointercancel', onPointerUp);

  // ---------------- weapons ----------------
  function respaceWeapons() {
    const n = weapons.length;
    weapons.forEach((w, i) => {
      w.slotAngleDeg = (360 / n) * i;
      w.el.style.transform =
        `translate(-50%, -50%) rotate(${w.slotAngleDeg}deg) translateY(-${WEAPON_RING_RADIUS}px) rotate(${-w.slotAngleDeg}deg)`;
    });
  }

  function addWeapon(typeKey) {
    if (weapons.length >= MAX_WEAPONS) return false;
    const el = document.createElement('div');
    el.className = 'ast-weapon-slot';
    el.textContent = WEAPON_TYPES[typeKey].emoji;
    rotorEl.appendChild(el);
    weapons.push({ typeKey, level: 1, slotAngleDeg: 0, lastFiredAt: 0, el });
    respaceWeapons();
    return true;
  }

  function upgradeWeapon(index) {
    const w = weapons[index];
    if (!w || w.level >= MAX_WEAPON_LEVEL) return false;
    w.level += 1;
    return true;
  }

  function getWeapons() {
    return weapons.map((w, i) => ({
      index: i,
      typeKey: w.typeKey,
      name: WEAPON_TYPES[w.typeKey].name,
      emoji: WEAPON_TYPES[w.typeKey].emoji,
      level: w.level,
      maxLevel: MAX_WEAPON_LEVEL,
      upgradeCost: w.level < MAX_WEAPON_LEVEL ? upgradeCost(w.typeKey, w.level) : null,
    }));
  }

  // ---------------- asteroids ----------------
  function spawnAsteroid() {
    if (asteroids.length >= MAX_CONCURRENT_ASTEROIDS) return;
    const angleDeg = Math.random() * 360;
    const el = document.createElement('div');
    el.className = 'ast-asteroid';
    el.textContent = ASTEROID_EMOJIS[Math.floor(Math.random() * ASTEROID_EMOJIS.length)];
    el.style.fontSize = `${28 + (asteroidMaxHp - 1) * 6}px`;
    arenaEl.appendChild(el);
    const asteroid = { id: nextAsteroidId++, angleDeg, radius: OUTER_RADIUS, hp: asteroidMaxHp, maxHp: asteroidMaxHp, el };
    positionAsteroidEl(asteroid);
    asteroids.push(asteroid);
  }

  function positionAsteroidEl(asteroid) {
    asteroid.el.style.transform =
      `translate(-50%, -50%) rotate(${asteroid.angleDeg}deg) translateY(-${asteroid.radius}px)`;
  }

  function removeAsteroid(asteroid) {
    asteroid.el.remove();
    asteroids = asteroids.filter((a) => a.id !== asteroid.id);
  }

  function spawnExplosion(angleDeg, radius) {
    const { x, y } = polarToXY(angleDeg, radius);
    const el = document.createElement('div');
    el.className = 'ast-explosion';
    el.textContent = '💥';
    el.style.left = `${CENTER + x}px`;
    el.style.top = `${CENTER + y}px`;
    arenaEl.appendChild(el);
    setTimeout(() => el.remove(), 400);
  }

  // ---------------- firing ----------------
  function findTarget(weapon) {
    const def = WEAPON_TYPES[weapon.typeKey];
    const reachRadius = INNER_RADIUS + (OUTER_RADIUS - INNER_RADIUS) * def.rangeFraction;
    const absoluteAngle = (weapon.slotAngleDeg + worldRotationDeg) % 360;
    let candidates = asteroids.filter((a) => a.radius <= reachRadius);
    if (!def.homing) {
      candidates = candidates.filter((a) => angleDiffDeg(a.angleDeg, absoluteAngle) <= def.arcDegrees / 2);
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.radius - b.radius);
    return candidates[0];
  }

  function fireProjectile(weapon, target, damage) {
    const def = WEAPON_TYPES[weapon.typeKey];
    const absoluteAngle = (weapon.slotAngleDeg + worldRotationDeg) % 360;
    const start = polarToXY(absoluteAngle, WEAPON_RING_RADIUS);
    const predictedRadius = Math.max(INNER_RADIUS, target.radius - asteroidSpeed * (def.projectileMs / 1000));
    const end = polarToXY(target.angleDeg, predictedRadius);
    const targetId = target.id;

    const el = document.createElement('div');
    el.className = `ast-projectile ast-projectile-${weapon.typeKey}`;
    arenaEl.appendChild(el);
    el.animate(
      [
        { transform: `translate(${start.x}px, ${start.y}px)` },
        { transform: `translate(${end.x}px, ${end.y}px)` },
      ],
      { duration: def.projectileMs, easing: 'linear', fill: 'forwards' }
    );

    setTimeout(() => {
      el.remove();
      const asteroid = asteroids.find((a) => a.id === targetId);
      if (!asteroid) return; // already gone (destroyed by another shot, or hit the world)
      asteroid.hp -= damage;
      if (asteroid.hp <= 0) {
        spawnExplosion(asteroid.angleDeg, asteroid.radius);
        removeAsteroid(asteroid);
        if (!earthHitThisWave) {
          asteroidsDestroyedTotal += 1;
          callbacks.onAsteroidDestroyed?.(asteroidsDestroyedTotal);
        }
      }
    }, def.projectileMs);
  }

  // ---------------- main loop ----------------
  function tick(timestamp) {
    if (!lastFrameTime) lastFrameTime = timestamp;
    const dt = Math.min(64, timestamp - lastFrameTime) / 1000;
    lastFrameTime = timestamp;

    if (rotationDirection !== 0) {
      worldRotationDeg = (worldRotationDeg + rotationDirection * ROTATION_SPEED_DEG_PER_SEC * dt + 360) % 360;
      rotorEl.style.transform = `rotate(${worldRotationDeg}deg)`;
    }

    if (waveActive) {
      spawnAccumulatorMs += dt * 1000;
      if (spawnAccumulatorMs >= spawnIntervalMs) {
        spawnAccumulatorMs = 0;
        spawnAsteroid();
      }

      for (const asteroid of [...asteroids]) {
        asteroid.radius -= asteroidSpeed * dt;
        if (asteroid.radius <= INNER_RADIUS) {
          removeAsteroid(asteroid);
          if (!earthHitThisWave) {
            earthHitThisWave = true;
            callbacks.onEarthHit?.();
          }
        } else {
          positionAsteroidEl(asteroid);
        }
      }

      for (const weapon of weapons) {
        const stats = statsForLevel(weapon.typeKey, weapon.level);
        if (timestamp - weapon.lastFiredAt < stats.fireRateMs) continue;
        const target = findTarget(weapon);
        if (target) {
          weapon.lastFiredAt = timestamp;
          fireProjectile(weapon, target, stats.damage);
        }
      }
    }

    rafHandle = requestAnimationFrame(tick);
  }
  rafHandle = requestAnimationFrame(tick);

  // ---------------- wave control ----------------
  function startWave(wave) {
    waveNumber = wave;
    waveActive = true;
    earthHitThisWave = false;
    spawnIntervalMs = Math.max(400, 1300 - wave * 60);
    asteroidSpeed = 26 + wave * 5;
    asteroidMaxHp = 1 + Math.floor((wave - 1) / 2);
    spawnAccumulatorMs = spawnIntervalMs; // spawn the first one almost immediately
  }

  function stopWave() {
    waveActive = false;
    for (const a of [...asteroids]) removeAsteroid(a);
  }

  function destroy() {
    waveActive = false;
    if (rafHandle) cancelAnimationFrame(rafHandle);
    arenaEl.removeEventListener('pointerdown', onPointerDown);
    arenaEl.removeEventListener('pointermove', onPointerMove);
    arenaEl.removeEventListener('pointerup', onPointerUp);
    arenaEl.removeEventListener('pointercancel', onPointerUp);
  }

  return {
    addWeapon,
    upgradeWeapon,
    getWeapons,
    startWave,
    stopWave,
    destroy,
    getWeaponCount: () => weapons.length,
    getMaxWeapons: () => MAX_WEAPONS,
    getAsteroidsDestroyed: () => asteroidsDestroyedTotal,
    getWave: () => waveNumber,
    didEarthGetHitThisWave: () => earthHitThisWave,
  };
}
