import { PRESETS, PLANETS_ORDER } from './hud-data.js'
import { PLANETS } from '../world/planet.js'
import { TIMES, systemTimeOfDay } from '../world/sky.js'
import { STATUS_LABEL } from '../game/colony.js'
import { FACE, FRAME_COLS, FRAME_ROWS } from '../agents/faces.js'
import { PLOT_PALETTE, hashString } from '../world/plots.js'

/**
 * The whole HUD, in plain DOM.
 *
 * Deliberately not a framework: this sits on top of a render loop that must not miss a
 * frame, so the UI only ever touches the DOM when something it shows has actually changed —
 * every setter compares against the last value it wrote and returns early otherwise.
 *
 * The one hard rule is that all of this is optional. Pressing H hides every panel, and the
 * game stays fully readable because status lives above the astronauts' heads in the scene,
 * not in here.
 */

/**
 * The page only ever runs on the machine the server is on — it answers nothing else — so the
 * browser's OS is the server's OS, and the name of the thing that shows a folder can be read
 * here rather than asked for.
 */
const IS_MAC = /Mac/.test(navigator.platform)
const IS_WIN = /Win/.test(navigator.platform)
const FILE_MANAGER = IS_MAC ? 'Finder' : IS_WIN ? 'Explorer' : 'Files'

const ICON = {
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  eye: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`,
  eyeOff: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19M6.6 6.6C4.06 8.2 2 11 2 11s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24M2 2l20 20"/></svg>`,
  home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M9.5 20v-6h5v6"/></svg>`,
  next: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/></svg>`,
  sun: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
  globe: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/></svg>`,
  camera: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 8.5h3.2l1.5-2h8.6l1.5 2H21v11H3z"/><circle cx="12" cy="14" r="3.4"/></svg>`,
  help: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.6v.4"/><path d="M12 17h.01"/></svg>`,
  open: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-8.5 8.5"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>`,
  archive: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18v3H3z"/><path d="M5 9v10h14V9"/><path d="M10 13h4"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 5.5 8 12l6.5 6.5"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 11.7a8 8 0 0 1-8.5 8 9.3 9.3 0 0 1-2.7-.4L4.5 21l1.4-4.1a7.9 7.9 0 0 1-2.4-5.7A8 8 0 0 1 12 3.6a8 8 0 0 1 8.5 8.1z"/><path d="M12 8.6v5.4M9.3 11.3h5.4"/></svg>`,
  folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.4A1.4 1.4 0 0 1 4.4 6h4.2l2 2.5h7A1.4 1.4 0 0 1 19 9.9v7.7a1.4 1.4 0 0 1-1.4 1.4H4.4A1.4 1.4 0 0 1 3 17.6z"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>`,
  locate: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7.6"/><path d="M12 1.8v2.6M12 19.6v2.6M1.8 12h2.6M19.6 12h2.6"/></svg>`,
  orbit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="4"/><ellipse cx="12" cy="12" rx="10.2" ry="4.6" transform="rotate(-24 12 12)"/><circle cx="21" cy="8.2" r="1.5" fill="currentColor" stroke="none"/></svg>`,
  sound: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a8 8 0 0 1 0 11"/></svg>`,
  soundOff: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>`,
}

const STAT_DEFS = [
  { key: 'working', label: 'building', cls: 'working' },
  { key: 'waiting', label: 'need you', cls: 'waiting' },
  { key: 'blocked', label: 'blocked', cls: 'blocked' },
  { key: 'celebrating', label: 'shipped', cls: 'done' },
  { key: 'conversations', label: 'tasks', cls: 'idle' },
  { key: 'workers', label: 'workers', cls: 'idle' },
]

export class Hud {
  constructor(root, settings, actions) {
    this.settings = settings
    this.actions = actions
    this.visible = true
    this._last = {}
    this.hiddenOpen = false

    this.el = document.createElement('div')
    this.el.className = 'hud'
    this.el.innerHTML = TEMPLATE
    // Rhythm owns every surrounding control; keep the standalone HUD operational but detached
    // so its state methods can still be reused without painting duplicate chrome.
    if (!Object.hasOwn(globalThis, 'colonyEmbedded')) root.appendChild(this.el)

    this.$ = (sel) => this.el.querySelector(sel)

    this._buildStats()
    this._buildSettings()
    this._buildAvatar()
    this._wire()
    this.syncSettings()
    // Read layout when panels resize/change, never in the animation loop.
    this._layoutObserver = new ResizeObserver(() => this._syncLayout())
    this._layoutObserver.observe(this.el)
    this._layoutObserver.observe(this.$('.side'))
    this._cardObserver = new ResizeObserver(() => {
      const card = this.$('.thread-pop')
      this._cardSize = { w: card.offsetWidth, h: card.offsetHeight }
    })
    this._cardObserver.observe(this.$('.thread-pop'))
    this._syncLayout()
  }

  // ── construction ────────────────────────────────────────────────────────────────────

  _buildStats() {
    const wrap = this.$('.stats')
    this.statEls = {}
    for (const def of STAT_DEFS) {
      const b = document.createElement('button')
      b.className = `stat ${def.cls}`
      b.type = 'button'
      b.dataset.key = def.key
      b.title = `Jump to the next ${def.label} bot`
      b.innerHTML = `<i class="pip"></i><span class="n">0</span><span class="lbl">${def.label}</span>`
      b.type = 'button'
      b.addEventListener('click', () => this.actions.focusStatus?.(def.key))
      wrap.appendChild(b)
      this.statEls[def.key] = b
    }
  }

  _buildSettings() {
    const body = this.$('.settings .body')
    const s = this.settings
    this.controls = []

    // Quality presets.
    body.appendChild(
      group(
        'Quality preset',
        chips(
          Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, title: p.hint })),
          () => s.get('preset'),
          (id) => s.applyPreset(id),
          this.controls
        )
      )
    )

    // Performance.
    const perf = group('Performance')
    perf.append(
      this._toggle('HDR + bloom', 'bloom', 'Glowing eyes, lamps and windows. The first thing to drop.'),
      this._toggle('Tilt-shift', 'tiltShift', 'A shallow depth of field, which is what makes the colony read as a model.'),
      this._slider(
        'Tilt-shift blur',
        'tiltShiftStrength',
        0,
        1,
        0.05,
        (v) => `${Math.round(v * 100)}%`,
        'Aperture: how shallow the focus is, and how far out of it things go.'
      ),
      this._slider(
        'Tilt-shift angle',
        'tiltShiftAngle',
        -90,
        90,
        1,
        (v) => `${v}°`,
        'Swings the plane of focus, the way tilting a real lens does.'
      ),
      this._select('Shadows', 'shadows', [
        ['off', 'Off'],
        ['low', 'Low'],
        ['high', 'High'],
        ['ultra', 'Ultra'],
      ]),
      this._select('Particles', 'particles', [
        ['off', 'Off'],
        ['low', 'Low'],
        ['full', 'Full'],
      ]),
      this._select('Textures', 'textureQuality', [
        ['low', 'Low'],
        ['medium', 'Medium'],
        ['high', 'High'],
        ['ultra', 'Ultra'],
      ]),
      this._select('Ground detail', 'groundDetail', [
        ['low', 'Low'],
        ['medium', 'Medium'],
        ['high', 'High'],
      ]),
      this._toggle('Anti-aliasing', 'antialias', 'SMAA pass. Cheap, but not free.'),
      this._slider(
        'Render scale',
        'renderScale',
        0.35,
        2,
        0.05,
        (v) => `${Math.round(v * 100)}%`,
        '100% is your display’s own resolution, retina included.'
      ),
      this._toggle('Adaptive quality', 'autoQuality', 'Quietly drops render scale if frames get expensive.'),
      this._slider('Scatter', 'scatterDensity', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
      this._slider('Max bots', 'maxAgents', 10, 200, 10, (v) => String(v)),
      this._toggle('Stars', 'stars')
    )
    body.appendChild(perf)

    // World.
    const world = group('Planet')
    const planets = document.createElement('div')
    planets.className = 'planets'
    for (const id of PLANETS_ORDER) {
      const planet = PLANETS[id]
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'planet'
      b.title = planet.blurb
      const c1 = hex(planet.ground.high)
      const c2 = hex(planet.ground.low)
      b.innerHTML = `<i class="orb" style="background:radial-gradient(circle at 33% 30%, ${c1}, ${c2})"></i><span>${planet.name}</span>`
      b.addEventListener('click', () => this.settings.set('planet', id))
      planets.appendChild(b)
      this.controls.push({ el: b, sync: () => b.setAttribute('aria-pressed', String(this.settings.get('planet') === id)) })
    }
    world.appendChild(planets)
    body.appendChild(world)

    // Lighting.
    const light = group('Lighting')
    light.append(
      chips(
        // `Live` is a time of day like the others from where you are standing, so it belongs
        // in the same row rather than in a toggle further down.
        [...TIMES.map((t) => ({ id: t.id, label: t.label })), { id: 'live', label: 'Live' }],
        () => (this.settings.get('clockTime') ? 'live' : nearestTime(this.settings.get('timeOfDay'))),
        (id) => {
          this.settings.set('autoTime', false)
          this.settings.set('clockTime', id === 'live')
          if (id === 'live') this.settings.set('timeOfDay', systemTimeOfDay())
          else this.settings.set('timeOfDay', TIMES.find((t) => t.id === id).value)
        },
        this.controls
      ),
      this._slider('Time of day', 'timeOfDay', 0, 1, 0.005, clockLabel, undefined, () => {
        // Reaching for the slider is a request for a particular light, so stop following the
        // clock — otherwise the next frame would drag the thumb straight back.
        this.settings.set('clockTime', false)
      }),
      this._toggle(
        'Cycle day/night',
        'autoTime',
        'Runs the clock forward on its own. Ignored while the sky is following this machine’s clock.'
      ),
      this._slider('Cycle length', 'dayLength', 30, 900, 30, (v) => `${Math.round(v / 60)}m`),
      this._toggle(
        'Environment light',
        'ibl',
        'Image-based lighting taken from this planet’s own sky. Metals get something to reflect.'
      ),
      this._slider('Environment', 'iblIntensity', 0, 2, 0.05, (v) => v.toFixed(2)),
      this._slider('Exposure', 'exposure', 0.4, 2, 0.05, (v) => v.toFixed(2)),
      this._slider('Bloom', 'bloomStrength', 0, 1.6, 0.02, (v) => v.toFixed(2))
    )
    body.appendChild(light)

    // View.
    const view = group('View')
    // The server refuses terminals on Windows, so a choice there would only ever toast an error.
    if (!IS_WIN) {
      view.append(
        this._select(
          'Open threads in',
          'openIn',
          [
            ['app', 'Desktop app'],
            ['terminal', 'Terminal'],
          ],
          'Terminal runs the harness’s own CLI in a new window, so the CLI has to be installed. ' +
            'BOT_CROSSING_TERMINAL or $TERMINAL picks the emulator.'
        )
      )
    }
    view.append(
      this._toggle(
        'Hide dormant repos',
        'hideDormant',
        'Takes a repo off the map when every thread in it has been quiet for three days. Its threads are untouched, and it comes back to the same ground the moment one wakes up.'
      )
    )
    view.append(
      this._toggle('Follow selected bot', 'followSelected', 'Tracks the selected bot until you deselect. Drag to pan, right-drag to orbit, and scroll to zoom.'),
      this._toggle('Return to isometric', 'autoFrame', 'Eases the angle back when you stop dragging.'),
      this._slider('Field of view', 'fov', 20, 60, 1, (v) => `${v}°`),
      this._toggle('Project labels', 'showLabels'),
      this._toggle('Reduced motion', 'reducedMotion', 'Calms the bobbing and the camera easing.'),
      this._toggle('Show FPS', 'showFps')
    )
    body.appendChild(view)

    // Look.
    const look = group('Look')
    look.append(
      this._slider(
        'Ambient occlusion',
        'ambientOcclusion',
        0,
        1,
        0.05,
        (v) => v === 0 ? 'Off' : `${Math.round(v * 100)}%`,
        'Soft shading in creases and where surfaces meet. Try 20–35% for a subtle effect; 0 turns it off.'
      ),
      this._slider(
        'World curve',
        'worldCurve',
        0,
        1,
        0.05,
        (v) => `${Math.round(v * 100)}%`,
        'How far the ground bends away toward the horizon. The point under the cursor never moves.'
      ),
      this._toggle('Colour grade', 'colorGrade', 'Saturation, warmth, lifted shadows and a soft vignette on the finished frame.'),
      this._slider('Saturation', 'saturation', 0.6, 1.5, 0.05, (v) => v.toFixed(2)),
      this._slider('Vignette', 'vignette', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
      this._toggle('Clouds', 'clouds', 'Cumulus drifting over worlds that have weather.'),
      this._select('Wildlife', 'fauna', [
        ['off', 'Off'],
        ['low', 'Some'],
        ['full', 'Full'],
      ])
    )
    body.appendChild(look)

    // Sound.
    const sound = group('Sound')
    sound.append(
      this._toggle(
        'Ambient sound',
        'sound',
        'A bed for each world, things calling out on their own clocks, and work you can hear where it is happening. Louder as you lean in.'
      ),
      this._slider('Master', 'masterVolume', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
      this._slider('Ambience', 'ambienceVolume', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`, 'Beds and the sounds of the world.'),
      this._slider('Effects', 'effectsVolume', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`, 'Hammering, drones, splashes, the chime when somebody needs you.')
    )
    body.appendChild(sound)
  }

  _row(label, hint) {
    const row = document.createElement('div')
    row.className = 'row'
    const l = document.createElement('div')
    l.className = 'label'
    l.innerHTML = `<span>${label}</span>${hint ? `<span class="hint">${hint}</span>` : ''}`
    row.appendChild(l)
    return row
  }

  _toggle(label, key, hint) {
    const row = this._row(label, hint)
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'toggle'
    b.setAttribute('role', 'switch')
    b.setAttribute('aria-label', label)
    b.addEventListener('click', () => this.settings.set(key, !this.settings.get(key)))
    row.appendChild(b)
    this.controls.push({
      el: row,
      sync: () => {
        b.setAttribute('aria-checked', String(Boolean(this.settings.get(key))))
        row.classList.toggle('overridden', this.settings.isOverridden(key))
      },
    })
    return row
  }

  _select(label, key, options, hint) {
    const row = this._row(label, hint)
    const sel = document.createElement('select')
    sel.className = 'select'
    for (const [value, text] of options) {
      const o = document.createElement('option')
      o.value = value
      o.textContent = text
      sel.appendChild(o)
    }
    sel.addEventListener('change', () => this.settings.set(key, sel.value))
    row.appendChild(sel)
    this.controls.push({
      el: row,
      sync: () => {
        sel.value = String(this.settings.get(key))
        row.classList.toggle('overridden', this.settings.isOverridden(key))
      },
    })
    return row
  }

  _slider(label, key, min, max, step, format, hint, onInput) {
    const row = this._row(label, hint)
    const wrap = document.createElement('div')
    wrap.style.cssText = 'display:flex;align-items:center;gap:8px'
    const input = document.createElement('input')
    input.type = 'range'
    input.setAttribute('aria-label', label)
    input.className = 'slider'
    input.min = min
    input.max = max
    input.step = step
    const out = document.createElement('span')
    out.className = 'value'
    input.addEventListener('input', () => {
      onInput?.()
      this.settings.set(key, Number(input.value))
    })
    wrap.append(input, out)
    row.appendChild(wrap)
    this.controls.push({
      el: row,
      sync: () => {
        const v = Number(this.settings.get(key))
        // Never fight the thumb the user is dragging.
        if (document.activeElement !== input) input.value = String(v)
        out.textContent = format(v)
        row.classList.toggle('overridden', this.settings.isOverridden(key))
      },
    })
    return row
  }

  /** The little face on the agent card, drawn from the same atlas the astronauts use. */
  _buildAvatar() {
    const canvas = this.$('.thread-pop .avatar canvas')
    canvas.width = 108
    canvas.height = 108
    this.avatarCtx = canvas.getContext('2d')
    this.avatarTmp = document.createElement('canvas')
    this.avatarTmp.width = 108
    this.avatarTmp.height = 108
    this.avatarTmpCtx = this.avatarTmp.getContext('2d')
    this._avatarState = { frame: -1, color: '' }
  }

  _wire() {
    const on = (sel, ev, fn) => this.$(sel).addEventListener(ev, fn)

    on('#btn-settings', 'click', () => this.toggleSettings())
    // On a phone the sidebar is a sheet: a tap on its brand row (not on its buttons) pulls
    // it up or lets it drop, and a drag on the row does the same by direction.
    const brandbar = this.$('.side .brandbar')
    const grab = this.$('.side .grab')
    let dragY = null
    const startDrag = (e) => {
      if (!this.isPhone() || e.target.closest('.btn')) return
      dragY = e.clientY
    }
    const endDrag = (e) => {
      if (dragY === null) return
      const dy = e.clientY - dragY
      dragY = null
      if (Math.abs(dy) > 24) this.toggleSheet(dy < 0)
      else if (!e.target.closest('.btn')) this.toggleSheet()
    }
    for (const el of [brandbar, grab]) {
      el.addEventListener('pointerdown', startDrag)
      el.addEventListener('pointerup', endDrag)
    }
    on('#btn-close-settings', 'click', () => this.toggleSettings(false))
    on('#btn-hide', 'click', () => this.toggleUi())
    on('#btn-help', 'click', () => this.toggleHelp())
    on('#btn-shot', 'click', () => this.actions.screenshot?.())
    on('#btn-home', 'click', () => this.actions.resetView?.())
    on('#btn-next', 'click', () => this.actions.focusStatus?.('waiting'))
    on('#btn-orbit', 'click', () => this.setOrbit(this.actions.toggleOrbit?.()))
    on('#btn-planet', 'click', () => this.actions.cyclePlanet?.())
    on('#btn-time', 'click', () => this.actions.cycleTime?.())
    on('#btn-sound', 'click', () => this.settings.set('sound', !this.settings.get('sound')))
    on('#btn-open', 'click', () => this.actions.openThread?.())
    on('#btn-viewed', 'click', () => this.actions.markViewed?.())
    on('#btn-archive', 'click', () => this.actions.archiveThread?.())
    on('#btn-deselect', 'click', () => this.actions.select?.(null))
    on('#btn-follow', 'click', () => this.settings.set('followSelected', !this.settings.get('followSelected')))
    on('#btn-new-session', 'click', () => this.actions.newConversation?.())
    on('#btn-reveal', 'click', () => this.actions.revealProject?.())
    on('#btn-copy-path', 'click', () => this.actions.copyProjectPath?.())
    on('#btn-open-terminal', 'click', () => this.actions.openThread?.('terminal'))
    on('#filter-query', 'input', (event) => this.actions.filterSessions?.({ query: event.target.value }))
    on('#filter-harness', 'change', (event) => this.actions.filterSessions?.({ harness: event.target.value }))
    on('#filter-status', 'change', (event) => this.actions.filterSessions?.({ status: event.target.value }))
    on('#filter-historical', 'change', (event) => this.actions.filterSessions?.({ includeHistorical: event.target.checked }))
    on('#btn-hide-project', 'click', () => this.actions.hideProject?.())
    on('#btn-hidden-toggle', 'click', () => this.toggleHiddenList())
    on('#btn-locate', 'click', () => this.actions.focusProject?.(this.project?.name))
    on('#btn-close-project', 'click', () => this.actions.closeProject?.())
    on('.help', 'click', (e) => {
      if (e.target === this.$('.help')) this.toggleHelp(false)
    })
    this.$('.help .sheet').addEventListener('click', (e) => e.stopPropagation())
    on('#btn-help-close', 'click', () => this.toggleHelp(false))

    this.settings.onChange(() => this.syncSettings())
  }

  // ── state in ────────────────────────────────────────────────────────────────────────

  syncSettings() {
    const follow = Boolean(this.settings.get('followSelected'))
    this.$('#btn-follow').setAttribute('aria-pressed', String(follow))
    this.$('#btn-follow').title = follow ? 'Stop following selected bot' : 'Follow selected bot'
    for (const c of this.controls) c.sync()
    this.$('.fps').classList.toggle('on', Boolean(this.settings.get('showFps')))
    const sound = Boolean(this.settings.get('sound'))
    const btn = this.$('#btn-sound')
    btn.innerHTML = sound ? ICON.sound : ICON.soundOff
    btn.setAttribute('aria-pressed', String(sound))
    btn.title = sound ? 'Mute (M)' : 'Unmute (M)'
  }

  setStats(stats) {
    for (const def of STAT_DEFS) {
      const n = stats[def.key] ?? 0
      const el = this.statEls[def.key]
      if (this._last['stat:' + def.key] === n) continue
      this._last['stat:' + def.key] = n
      el.querySelector('.n').textContent = String(n)
      el.setAttribute('aria-label', `${n} ${def.label}`)
      el.dataset.empty = String(n === 0)
    }
  }

  setHistoricalCount(count) {
    if (this._last.historicalCount === count) return
    this._last.historicalCount = count
    this.$('.historical-count').textContent = `(${count})`
  }

  /**
   * Every repo, in the sidebar. This was a strip of chips along the bottom of the screen;
   * it is a list now because the sidebar is where all the chrome lives, and because a list
   * can carry a count and an alarm without running out of room at eleven repos.
   */
  setLegend(projects, activeName = null, hidden = [], folded = []) {
    const signature =
      projects.map((p) => `${p.name}:${p.displayName}:${p.category}:${p.count}:${p.workers}:${p.accent}:${p.urgent ? 1 : 0}`).join('|') +
      `~${activeName}~` +
      hidden.map((p) => `${p.name}:${p.count}`).join('|') +
      `~${folded.length}`
    if (this._last.legend === signature) return
    this._last.legend = signature

    const wrap = this.$('.projects')
    wrap.innerHTML = ''
    const sections = [
      { category: 'repository', label: 'Repositories' },
      { category: 'workspace', label: 'Other workspaces' },
      { category: 'historical', label: 'Historical locations' },
    ]
    for (const section of sections) {
      const entries = projects.filter(p => p.category === section.category)
      if (!entries.length) continue
      const heading = document.createElement('h2')
      heading.className = 'project-category'
      heading.textContent = `${section.label} (${entries.length})`
      wrap.appendChild(heading)
      if (section.category === 'historical') {
        const note = document.createElement('p')
        note.className = 'project-category-note'
        note.textContent = 'Missing or unresolved folders'
        wrap.appendChild(note)
      }
      for (const p of entries) {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'repo'
        b.title = `${p.count} conversations, ${p.workers || 0} workers · ${p.path || p.displayName || p.name}`
        b.setAttribute('aria-pressed', String(p.name === activeName))
        b.innerHTML =
          `<i class="swatch" style="background:${hex(p.accent)};color:${hex(p.accent)}"></i>` +
          `<span class="n">${escapeHtml(p.displayName || p.name)}${p.path ? `<small>${escapeHtml(shortPath(p.path))}</small>` : ''}</span>` +
          (p.urgent ? '<i class="alarm"></i>' : '') +
          `<span class="count">${p.count}${p.workers ? ` + ${p.workers}w` : ''}</span>`
        b.addEventListener('click', () => this.actions.pickProject?.(p.name))
        wrap.appendChild(b)
      }
    }
    const repos = projects.filter(p => p.category === 'repository').length
    const workspaces = projects.filter(p => p.category === 'workspace').length
    this.$('.sec-head span').textContent = `${repos} repositor${repos === 1 ? 'y' : 'ies'} · ${workspaces} workspace${workspaces === 1 ? '' : 's'}`
    if (!projects.length) {
      const empty = document.createElement('p')
      empty.className = 'project-category-note'
      empty.textContent = 'No locations match these filters.'
      wrap.appendChild(empty)
    }

    // The hidden list is its own block at the foot of the sidebar: collapsed by default, because
    // the whole point of hiding a repo is not to look at it.
    const block = this.$('.hidden-block')
    block.hidden = hidden.length === 0 && folded.length === 0
    const hiddenWrap = this.$('.hidden-projects')
    hiddenWrap.innerHTML = ''
    for (const p of hidden) {
      const accent = PLOT_PALETTE[hashString(p.name) % PLOT_PALETTE.length]
      const row = document.createElement('div')
      row.className = 'repo hidden-repo'
      row.innerHTML =
        `<i class="swatch" style="background:${hex(accent)};color:${hex(accent)}"></i>` +
        `<span class="n">${escapeHtml(p.displayName || p.name)}${p.path ? `<small>${escapeHtml(shortPath(p.path))}</small>` : ''}</span>` +
        `<span class="count">${p.count}${p.workers ? ` + ${p.workers}w` : ''}</span>`
      const show = document.createElement('button')
      show.type = 'button'
      show.className = 'btn ghost show-repo'
      show.title = `Show ${p.name} on the map again`
      show.textContent = 'Show'
      show.addEventListener('click', () => this.actions.unhideProject?.(p.name))
      row.appendChild(show)
      hiddenWrap.appendChild(row)
    }

    // The dormant fold gets one line rather than a row each: it is a setting, not a list of
    // decisions, and the thing worth offering is the way back rather than per-repo control.
    if (folded.length) {
      const n = folded.reduce((sum, p) => sum + p.count, 0)
      const row = document.createElement('div')
      row.className = 'repo hidden-repo folded-note'
      row.innerHTML =
        `<span class="n">${folded.length} quiet repo${folded.length === 1 ? '' : 's'}` +
        `, ${n} thread${n === 1 ? '' : 's'}</span>`
      const show = document.createElement('button')
      show.type = 'button'
      show.className = 'btn ghost show-repo'
      show.title = 'Put dormant repos back on the map'
      show.textContent = 'Show'
      show.addEventListener('click', () => this.settings.set('hideDormant', false))
      row.appendChild(show)
      hiddenWrap.appendChild(row)
    }

    const total = hidden.length + folded.length
    this.$('#btn-hidden-toggle .label').textContent = `${total} off the map`
    this._syncHiddenList()
  }

  toggleHiddenList() {
    this.hiddenOpen = !this.hiddenOpen
    this._syncHiddenList()
  }

  _syncHiddenList() {
    this.$('#btn-hidden-toggle').setAttribute('aria-expanded', String(this.hiddenOpen))
    this.$('.hidden-projects').hidden = !this.hiddenOpen
  }

  /**
   * The project sidebar: what a zone is, and the things you can do to the *repo* rather
   * than to one thread in it. Opened by clicking a zone, its name plate, its legend chip,
   * or any astronaut standing on it.
   */
  setProject(project) {
    const panel = this.$('.side')
    if (!project) {
      this.project = null
      if (this._last.project === null) return
      this._last.project = null
      panel.classList.remove('drilled')
      panel.classList.remove('open')
      this._syncLayout()
      return
    }

    this.project = project
    // On a phone, opening a repo pulls the sheet up so its threads are in view — unless an
    // astronaut was just picked, whose card wants the room above the sheet's peek.
    if (this.isPhone() && !this.selected && !panel.classList.contains('open')) {
      panel.classList.add('open')
      this._syncLayout()
    }
    // The minute is part of the signature because `ago()` is: without it a repo where
    // nothing is happening keeps whatever "4m ago" it was first drawn with, for as long as
    // you leave the panel open.
    const signature =
      `${project.name}~${project.path}~${project.accent}~${project.selectedId}~${Math.floor(Date.now() / 60000)}~` +
      JSON.stringify([project.threads.map(t => [t.id,t.status,t.title,t.lastActivityAt,t.parentId,t.checkoutId]), project.checkouts, project.overrides, project.filters])
    panel.classList.add('drilled')
    if (this._last.project === signature) return
    this._last.project = signature

    const swatch = this.$('.side .who .swatch')
    swatch.style.background = hex(project.accent)
    swatch.style.color = hex(project.accent) // the halo is `currentColor`
    this.$('.side .name').textContent = project.displayName || project.name
    const path = this.$('.side .path')
    path.textContent = project.path || 'Folder unknown'
    path.title = project.path || ''
    // Nothing to open a new thread in, and nothing to reveal, without a folder on disk.
    this.$('#btn-new-session').disabled = !project.path || !project.pathAvailable
    this.$('#btn-reveal').disabled = !project.path || !project.pathAvailable
    this.$('#btn-copy-path').disabled = !project.path

    const checkouts = this.$('.checkouts')
    checkouts.innerHTML = ''
    const allCheckouts = document.createElement('button')
    allCheckouts.className = 'btn ghost'
    allCheckouts.textContent = 'All checkouts'
    allCheckouts.setAttribute('aria-pressed', String(!project.filters.checkout))
    allCheckouts.onclick = () => this.actions.selectCheckout?.('')
    checkouts.appendChild(allCheckouts)
    for (const checkout of project.checkouts || []) {
      const row = document.createElement('details')
      row.className = 'checkout'
      row.open = checkout.id === project.selectedCheckout
      const members = project.allThreads.filter(t => t.checkoutId === checkout.id)
      const active = members.filter(t => t.running === true)
      const harnesses = [...new Set(members.map(t => t.harnessName || t.harness))]
      const dirty = checkout.dirty === true ? 'Uncommitted / untracked' : checkout.dirty === false ? 'Clean' : 'Git state unknown'
      const activity = checkout.missing ? 'Missing path' : active.length ? `${active.length} active agent${active.length === 1 ? '' : 's'}` :
        members.some(t => t.activity === 'unknown' || t.running == null) ? 'Activity unknown' : 'Quiet'
      row.innerHTML = `<summary><strong>${escapeHtml(checkout.main ? 'Main checkout' : checkout.kind === 'git' ? 'Worktree' : 'Directory')}</strong>` +
        `<span>${escapeHtml(checkout.branch || '')} · ${escapeHtml(activity)}</span></summary>` +
        `<div class="checkout-path">${escapeHtml(checkout.path)}</div>` +
        `<p>${escapeHtml(dirty)}${active.length > 1 ? ' · Shared checkout: concurrent observed agents' : ''}</p>` +
        `<p>${escapeHtml(harnesses.join(', ') || 'No recorded conversations')} · ${members.length} recorded sessions</p>` +
        `<p class="evidence">${escapeHtml(checkout.evidence || '')}</p>`
      const controls = document.createElement('div')
      controls.className = 'pair'
      const inspect = document.createElement('button')
      inspect.className = 'btn'; inspect.textContent = 'Inspect checkout'
      inspect.onclick = () => this.actions.selectCheckout?.(checkout.id)
      controls.appendChild(inspect)
      const copy = document.createElement('button')
      copy.className = 'btn'; copy.textContent = 'Copy path'
      copy.onclick = () => this.actions.copyPath?.(checkout.path)
      controls.appendChild(copy)
      const reveal = document.createElement('button')
      reveal.className = 'btn'; reveal.textContent = FILE_MANAGER; reveal.disabled = checkout.missing
      reveal.title = checkout.missing ? 'Recorded folder is missing' : `Reveal ${checkout.path}`
      reveal.onclick = () => this.actions.revealPath?.(checkout.path)
      controls.appendChild(reveal)
      row.appendChild(controls)
      const label = document.createElement('label')
      label.className = 'group-label'; label.textContent = 'Group this checkout with project'
      const grouping = document.createElement('select')
      grouping.setAttribute('aria-label', `Group checkout ${checkout.path}`)
      const automatic = document.createElement('option')
      automatic.value = ''; automatic.textContent = 'Automatic Git grouping (reset override)'
      grouping.appendChild(automatic)
      for (const p of project.options) {
        const option = document.createElement('option')
        option.value = p.id; option.textContent = `${p.name} · ${p.path || p.id}`
        grouping.appendChild(option)
      }
      grouping.value = project.overrides[checkout.id] || ''
      grouping.onchange = () => this.actions.groupCheckout?.(checkout.id, grouping.value)
      label.appendChild(grouping); row.appendChild(label)
      checkouts.appendChild(row)
    }
    const roots = project.threads.filter(t => !t.parentId).length
    const workers = project.threads.length - roots
    this.$('.side .threads-head').textContent = `${roots} conversations · ${workers} workers`
    const list = this.$('.side .threads')
    const scroll = list.scrollTop
    list.innerHTML = ''
    const nodes = new Map(project.allThreads.map(t => [t.id, t]))
    const visible = new Set(project.threads.map(t => t.id))
    const ordered = []
    const emitted = new Set()
    const children = new Map()
    for (const t of project.threads) {
      if (!children.has(t.parentId)) children.set(t.parentId, [])
      children.get(t.parentId).push(t)
    }
    const append = (t, depth = 0) => {
      if (emitted.has(t.id)) return
      emitted.add(t.id)
      if (visible.has(t.id)) ordered.push({ ...t, depth })
      for (const child of children.get(t.id) || []) append(child, depth + 1)
    }
    for (const t of project.threads) if (!t.parentId || !visible.has(t.parentId)) append(t)
    for (const t of project.threads) append(t)
    const draw = (limit) => {
      list.innerHTML = ''
      for (const t of ordered.slice(0, limit)) {
        const b = document.createElement('button')
        b.type = 'button'; b.className = `thread ${statusClass(t.status)}`
        b.style.paddingLeft = `${12 + Math.min(t.depth, 4) * 12}px`
        b.setAttribute('aria-pressed', String(t.id === project.selectedId))
        const parent = t.parentId && nodes.get(t.parentId)
        b.title = `${t.cwd || ''} · ${t.activityEvidence || STATUS_LABEL[t.status] || t.status || ''}`
        b.innerHTML = '<i class="pip"></i>' +
          `<span class="t">${escapeHtml(t.title || 'Untitled conversation')}</span>` +
          `<span class="when">${ago(t.lastActivityAt)}</span>` +
          `<span class="wt">${escapeHtml([t.parentId ? 'Worker' : 'Conversation', t.harnessName, t.agentName || t.agentNickname || t.profile, t.gitBranch, t.activity === 'unknown' ? 'Activity unknown' : t.activity, t.archived ? 'Archived' : ''].filter(Boolean).join(' · '))}</span>` +
          (t.parentId ? `<span class="wt">Parent: ${escapeHtml(parent?.title || t.parentTitle || 'unavailable')} ${parent?.archived ? '(archived)' : ''}</span>` : '')
        b.onclick = () => this.actions.focusThread?.(t.id)
        list.appendChild(b)
      }
      if (ordered.length > limit) {
        const more = document.createElement('button')
        more.className = 'btn'; more.textContent = `Show more (${ordered.length - limit} remaining)`
        more.onclick = () => draw(limit + 100); list.appendChild(more)
      }
      if (!ordered.length) list.textContent = 'No sessions match these filters.'
    }
    draw(100)
    list.scrollTop = scroll
    if (!project.selectedId) this._scrolledTo = null
  }

  /**
   * The selected thread, shown inside the zone sidebar rather than in a panel of its own —
   * one thread and its repo are the same context, and splitting them across the screen made
   * you look in two places to act on one astronaut.
   */
  setSelection(agent, thread) {
    const card = this.$('.thread-pop')
    // Only ever one accent button in the panel: whichever action is the immediate one.
    this.$('#btn-new-session').classList.toggle('primary', !agent || !thread)
    if (!agent || !thread) {
      card.classList.remove('on')
      this.selected = null
      return
    }
    if (this.selected?.thread.id !== thread.id) this.$('.thread-pop .session-details').open = false
    this.selected = { agent, thread }
    card.classList.add('on')
    // On a phone the card docks above the sheet's peek, so the sheet drops to make room.
    if (this.isPhone()) this.toggleSheet(false)

    this.$('.thread-pop .title').textContent = thread.title || 'Untitled thread'
    this.$('.thread-pop .title').title = thread.title || 'Untitled thread'
    const status = STATUS_LABEL[agent.status] || agent.status
    const meta = this.$('.thread-pop .meta')
    const bits = [
      `<span class="tag"><i class="swatch" style="background:${hex(agent.trim.getHex())}"></i>${escapeHtml(status)}</span>`,
    ]
    // The repo is the panel's own heading now, so the card says what the *thread* is —
    // starting with whose it is, since that decides what Open can do.
    if (thread.harnessName) bits.push(`<span class="tag">${escapeHtml(thread.harnessName)}</span>`)
    bits.push(`<span>${ago(thread.lastActivityAt)}</span>`)
    meta.innerHTML = bits.join('')

    const identity = thread.agentName || thread.agentNickname
    this.$('.thread-pop .session-context').textContent = [thread.parentId ? 'Worker' : 'Task',
      identity && identity !== thread.title ? identity : ''].filter(Boolean).join(' · ')
    const path = this.$('.thread-pop .session-path')
    path.textContent = thread.cwd || 'Working folder unknown'
    path.title = thread.cwd || 'No working folder was recorded'
    const branch = this.$('.thread-pop .session-branch')
    branch.textContent = thread.gitBranch || ''
    branch.title = thread.gitBranch || ''
    branch.hidden = !thread.gitBranch

    const pct = Math.round((this.actions.progressFor?.(thread.id) ?? 0) * 100)
    this.$('.thread-pop .progress > i').style.width = `${pct}%`
    this.$('.thread-pop .progress > i').style.background = hex(agent.trim.getHex())
    const capability = thread.openCapabilities?.[this.settings.get('openIn')]
    this.$('#btn-open').disabled = thread.canOpen === false || capability?.available === false
    this.$('#btn-open').title = capability?.reason || thread.openUnavailableReason || thread.navigationReason || 'Open this conversation in its harness'
    this.$('#btn-open-terminal').hidden = !thread.openCapabilities?.terminal?.available || this.settings.get('openIn') === 'terminal'
    const openingReason = capability?.available === false ? capability.reason : thread.canOpen === false ?
      thread.openUnavailableReason || thread.navigationReason || 'Conversation opening is unavailable.' : ''
    const details = [
      ['Model', thread.model && shortModel(thread.model)],
      ['Profile', thread.profile],
      ['Worktree', thread.worktree],
      ['Activity', thread.activityEvidence],
      ['Opening', openingReason],
      ['Read status', thread.unread == null ? 'Unknown. Use Viewed to track new changes here.' : ''],
    ].filter(([, value]) => value)
    this.$('.thread-pop .session-details-body').innerHTML = details
      .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('')
    this.$('.thread-pop .session-details').hidden = !details.length
    this.$('.thread-pop .session-open-notice').hidden = !openingReason
    this.$('.thread-pop .session-open-notice').textContent = openingReason ? 'Opening unavailable — see details' : ''
    const relation = this.$('.session-parent')
    relation.hidden = !thread.parentId
    relation.disabled = !!thread.orphaned
    relation.title = thread.orphaned ? 'Parent conversation is unavailable in this local store' : 'Inspect the parent conversation'
    relation.textContent = thread.parentId ? thread.orphaned ? 'Parent unavailable' : 'Inspect parent task' : ''
    relation.onclick = () => this.actions.focusThread?.(thread.parentId)
    // Only offered when there is something to dismiss. A third button on every card would
    // crowd the two that are always worth having, and "Viewed" on a thread that is not asking
    // for anything is a control with no effect.
    this.$('#btn-viewed').hidden = thread.unread === false
    // Expansion and responsive resizing also update this through ResizeObserver.
    this._cardSize = { w: card.offsetWidth, h: card.offsetHeight }
  }

  /**
   * Put the thread card beside its own astronaut, in screen space, every frame.
   *
   * `screen` is where the astronaut is right now, in CSS pixels, or null when it is behind
   * the camera. The card prefers the astronaut's right, flips to its left rather than slide
   * under the sidebar, and never leaves the window — so it stays reachable at any zoom
   * without ever covering the thing it is describing.
   */
  placeCard(screen) {
    const el = this.$('.thread-pop')
    if (!screen || !this.selected) {
      if (this._cardOn) {
        this._cardOn = false
        el.classList.remove('on')
      }
      return
    }
    // On a phone the card is docked above the sheet by the stylesheet; nothing to place.
    if (this.isPhone()) {
      if (!this._cardOn) {
        this._cardOn = true
        el.classList.add('on')
      }
      return
    }
    const size = this._cardSize || { w: 280, h: 150 }
    const margin = 12
    const gap = 26
    const rightWall = window.innerWidth - margin - (this._sideWidth || 0)

    let flip = false
    let left = screen.x + gap
    if (left + size.w > rightWall) {
      left = screen.x - gap - size.w
      flip = true
      // Nowhere to go on either side — sit over the middle rather than off the edge.
      if (left < margin) left = Math.min(Math.max(margin, screen.x - size.w / 2), rightWall - size.w)
    }
    const top = Math.min(Math.max(margin, screen.y - size.h / 2), window.innerHeight - margin - size.h)

    if (!this._cardOn) {
      this._cardOn = true
      el.classList.add('on')
    }
    // Whole pixels, and only when it actually moved: a transform written every frame with a
    // fractional delta is a repaint the compositor cannot skip.
    const x = Math.round(left)
    const y = Math.round(top)
    if (x !== this._cardX || y !== this._cardY) {
      this._cardX = x
      this._cardY = y
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`
    }
    // The nib points back at the astronaut, so it changes sides with the card.
    if (flip !== this._cardFlip) {
      this._cardFlip = flip
      el.classList.toggle('flip', flip)
    }
    // And it tracks the astronaut vertically when the card has been pushed off-centre.
    const nib = Math.min(Math.max(14, screen.y - y), size.h - 14)
    if (nib !== this._cardNib) {
      this._cardNib = nib
      el.style.setProperty('--nib-y', `${Math.round(nib)}px`)
    }
  }

  /** Share one measured safe area between camera framing, cards, and the legend. */
  _syncLayout() {
    const width = this.el.clientWidth
    const height = this.el.clientHeight
    const side = this.$('.side')
    let right = 0
    let bottom = 0
    if (this.visible) {
      if (this.isPhone()) {
        // Use the sheet's destination, not an intermediate animation transform.
        const peek = parseFloat(getComputedStyle(this.el).getPropertyValue('--peek')) || 0
        const top = side.offsetTop + (side.classList.contains('open') ? 0 : side.offsetHeight - peek)
        bottom = Math.max(0, height - top)
      } else {
        right = Math.max(0, width - side.offsetLeft)
      }
    }
    this._sideWidth = right
    this.el.style.setProperty('--side', `${right}px`)
    this.actions.viewportChanged?.({ width, height, right, bottom })
  }

  /** Redraw the card's face so it blinks in step with the astronaut it belongs to. */
  updateAvatar(faceAtlasCanvas) {
    if (!this.selected || !faceAtlasCanvas) return
    const agent = this.selected.agent
    const frame = agent.faceFrame ?? FACE.idle
    const color = agent.eye
    const css = cssFromGlow(color)
    if (this._avatarState.frame === frame && this._avatarState.color === css) return
    this._avatarState = { frame, color: css }

    const size = 108
    const cell = faceAtlasCanvas.width / FRAME_COLS
    const sx = (frame % FRAME_COLS) * cell
    const sy = Math.floor(frame / FRAME_COLS) * (faceAtlasCanvas.height / FRAME_ROWS)

    // The atlas is an opaque white-on-black mask, so the tint is a `multiply`, not a
    // `source-in`: black stays black and the white features take the eye colour. Keying on
    // alpha instead would flood the whole cell, because every pixel in it is opaque.
    const t = this.avatarTmpCtx
    t.globalCompositeOperation = 'source-over'
    t.clearRect(0, 0, size, size)
    t.drawImage(faceAtlasCanvas, sx, sy, cell, cell, 0, 0, size, size)
    t.globalCompositeOperation = 'multiply'
    t.fillStyle = css
    t.fillRect(0, 0, size, size)
    t.globalCompositeOperation = 'source-over'

    const c = this.avatarCtx
    c.fillStyle = '#06070c'
    c.fillRect(0, 0, size, size)
    c.drawImage(this.avatarTmp, 0, 0)
    // Scanlines, so the card's face reads as the same little screen as the one in the world.
    c.globalAlpha = 0.2
    c.fillStyle = '#000'
    for (let y = 0; y < size; y += 3) c.fillRect(0, y, size, 1)
    c.globalAlpha = 1
  }

  setFps(perf, viewport, extra) {
    if (!this.settings.get('showFps')) return
    const el = this.$('.fps')
    const fps = Math.round(perf.fps)
    if (this._last.fps === fps && this._last.calls === perf.drawCalls) return
    this._last.fps = fps
    this._last.calls = perf.drawCalls
    el.innerHTML =
      `<b>${fps}</b> fps · ${perf.frameMs.toFixed(1)} ms<br>` +
      `${perf.drawCalls} draws · ${(perf.triangles / 1000).toFixed(0)}k tris<br>` +
      // The setting is a share of the display, so the readout is too — otherwise a retina
      // machine sitting exactly on the 100% slider reads back "200%".
      `${viewport.bw}×${viewport.bh} (${Math.round((viewport.scale / (window.devicePixelRatio || 1)) * 100)}%)` +
      (extra ? `<br>${extra}` : '')
  }

  hint(text, ms = 3200) {
    const el = this.$('.hint-pill')
    el.textContent = text
    el.classList.add('on')
    clearTimeout(this._hintTimer)
    this._hintTimer = setTimeout(() => el.classList.remove('on'), ms)
  }

  toast(message, kind = '') {
    const el = document.createElement('div')
    el.className = `toast panel ${kind}`
    el.textContent = message
    this.$('.toasts').appendChild(el)
    setTimeout(() => {
      el.classList.add('leaving')
      setTimeout(() => el.remove(), 260)
    }, 3600)
  }

  // ── visibility ──────────────────────────────────────────────────────────────────────

  /** Reflect orbit mode on the rail button. */
  setOrbit(on) {
    this.$('#btn-orbit').setAttribute('aria-pressed', String(Boolean(on)))
  }

  /** Whether the layout is the phone one: the sheet, the docked card, the top rail. */
  isPhone() {
    return window.matchMedia('(max-width: 600px)').matches
  }

  /** Pull the sidebar sheet up over the colony, or let it drop to its peek. Phone only. */
  toggleSheet(force) {
    const side = this.$('.side')
    const open = force ?? !side.classList.contains('open')
    side.classList.toggle('open', open)
    this._syncLayout()
    return open
  }

  toggleSettings(force) {
    const panel = this.$('.settings')
    const open = force ?? panel.classList.contains('closed')
    panel.classList.toggle('closed', !open)
    this.$('#btn-settings').setAttribute('aria-pressed', String(open))
    // Settings replaces the sidebar in its existing slot, including for keyboard users.
    const side = this.$('.side')
    side.classList.toggle('covered', open)
    side.inert = open
    panel.inert = !open
    if (open) this.$('#btn-close-settings').focus({ preventScroll: true })
    else if (panel.contains(document.activeElement)) this.$('#btn-settings').focus({ preventScroll: true })
  }

  toggleHelp(force) {
    const el = this.$('.help')
    const open = force ?? !el.classList.contains('open')
    el.classList.toggle('open', open)
  }

  /**
   * Dismiss everything. This is the mode the game is really meant to be left in — the
   * colony carries its own state above the astronauts' heads, so the panels are for
   * setting things up, not for playing.
   */
  toggleUi(force) {
    this.visible = force ?? !this.visible
    this.el.classList.toggle('hidden', !this.visible)
    this.$('#btn-hide').innerHTML = this.visible ? ICON.eye : ICON.eyeOff
    this.actions.uiVisibility?.(this.visible)
    this._syncLayout()
    if (!this.visible) this.toggleHelp(false)
    return this.visible
  }

  removeBoot() {
    const boot = document.querySelector('.boot')
    if (!boot) return
    boot.classList.add('gone')
    setTimeout(() => boot.remove(), 550)
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────────────

function group(title, child) {
  const el = document.createElement('div')
  el.className = 'group'
  el.innerHTML = `<h3>${title}</h3>`
  if (child) el.appendChild(child)
  return el
}

function chips(items, current, onPick, registry) {
  const wrap = document.createElement('div')
  wrap.className = 'chips'
  const buttons = []
  for (const item of items) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'chip'
    b.textContent = item.label
    if (item.title) b.title = item.title
    b.addEventListener('click', () => onPick(item.id))
    wrap.appendChild(b)
    buttons.push([item.id, b])
  }
  registry.push({
    el: wrap,
    sync: () => {
      const now = current()
      for (const [id, b] of buttons) b.setAttribute('aria-pressed', String(id === now))
    },
  })
  return wrap
}

const hex = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0').slice(-6)
/**
 * Eye colours are authored above 1.0 so the bloom pass catches them in the scene. For the
 * card they are normalised by the brightest channel — which keeps the hue the astronaut
 * actually has rather than clipping a 3.0-red down to the same white as a 3.0-blue.
 */
function cssFromGlow(color) {
  const peak = Math.max(color.r, color.g, color.b, 1)
  const enc = (v) => Math.round(Math.pow(Math.min(1, v / peak), 1 / 2.2) * 255)
  return `rgb(${enc(color.r)},${enc(color.g)},${enc(color.b)})`
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

/** Status → the colour family the top-bar counters already use for it. */
function statusClass(status) {
  if (status === 'working') return 'working'
  if (status === 'waiting') return 'waiting'
  if (status === 'blocked') return 'blocked'
  if (status === 'celebrating') return 'done'
  return 'idle'
}

/**
 * A path that fits, trimmed from the *left* so the repo end survives — the deep end is the
 * part that identifies it. CSS can only ellipsise the tail, and `direction: rtl` mangles a
 * leading `~`, so the trim is done here and the whole path lives in the title attribute.
 */
function shortPath(dir, max = 30) {
  const home = dir.replace(/^\/Users\/[^/]+/, '~')
  if (home.length <= max) return home
  const parts = home.split('/')
  let out = parts.pop() || ''
  while (parts.length) {
    const next = parts.pop()
    if (out.length + next.length + 3 > max) break
    out = `${next}/${out}`
  }
  return `…/${out}`
}

function shortModel(model) {
  return String(model).replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

function clockLabel(t) {
  const total = t * 24 * 60
  const h = Math.floor(total / 60) % 24
  const m = Math.floor(total % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function nearestTime(value) {
  let best = TIMES[0]
  let bestD = Infinity
  for (const t of TIMES) {
    // Wrap-aware, so 0.99 is nearest to dawn rather than to noon.
    const d = Math.min(Math.abs(t.value - value), 1 - Math.abs(t.value - value))
    if (d < bestD) {
      bestD = d
      best = t
    }
  }
  return bestD < 0.03 ? best.id : null
}

function ago(ts) {
  if (!ts) return 'never'
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const TEMPLATE = `
<aside class="side panel">
  <div class="grab"></div>
  <header class="brandbar">
    <div class="brand"><i class="dot"></i>Bot Crossing</div>
    <button class="btn icon ghost" id="btn-shot" title="Screenshot (P)">${ICON.camera}</button>
    <button class="btn icon ghost" id="btn-help" title="Help (?)">${ICON.help}</button>
    <button class="btn icon ghost" id="btn-hide" title="Hide all UI (H)">${ICON.eye}</button>
    <button class="btn icon ghost" id="btn-settings" title="Settings (S)" aria-pressed="false">${ICON.settings}</button>
  </header>

  <div class="stats"></div>
  <p class="scan-notice" role="status" hidden></p>

  <div class="session-filters">
    <input id="filter-query" type="search" aria-label="Search projects and sessions" placeholder="Find project, branch, path or task">
    <div class="pair">
      <select id="filter-harness" aria-label="Filter by harness"><option value="">All harnesses</option><option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="hermes">Hermes</option><option value="rhythm">Rhythm</option><option value="opencode">OpenCode</option><option value="cursor">Cursor</option><option value="antigravity">Antigravity</option><option value="kilocode">Kilo Code</option></select>
      <select id="filter-status" aria-label="Filter by status"><option value="">All activity</option><option value="active">Active</option><option value="quiet">Quiet</option><option value="unknown">Unknown</option><option value="attention">Needs attention</option><option value="worker">Workers</option><option value="archived">Archived</option></select>
    </div>
    <label class="historical-filter" title="Include sessions from missing or unresolved folders in the list and colony">
      <input id="filter-historical" type="checkbox"> Include historical locations <span class="historical-count">(0)</span>
    </label>
  </div>
  <div class="side-body">
    <div class="projects-pane">
      <div class="sec-head"><span>Repos</span></div>
      <div class="projects"></div>
      <div class="hidden-block" hidden>
        <button type="button" class="hidden-toggle" id="btn-hidden-toggle" aria-expanded="false">
          <span class="label">0 hidden</span>
        </button>
        <div class="hidden-projects" hidden></div>
      </div>
    </div>

    <div class="project-detail">
      <button class="btn ghost back" id="btn-close-project" title="Back to the workspace overview (Esc)">${ICON.back} Overview</button>
      <div class="who">
        <i class="swatch"></i>
        <div class="text">
          <div class="name"></div>
          <div class="path"></div>
        </div>
        <button class="btn icon ghost" id="btn-locate" title="Fly to this zone">${ICON.locate}</button>
      </div>
      <div class="project-actions">
        <button class="btn primary" id="btn-new-session" title="Start a new thread in this folder (C)">${ICON.plus} New conversation</button>
        <div class="pair">
          <button class="btn" id="btn-reveal" title="Show this folder in ${FILE_MANAGER}">${ICON.folder} ${FILE_MANAGER}</button>
          <button class="btn" id="btn-copy-path" title="Copy the folder path">${ICON.copy} Copy path</button>
        </div>
        <button class="btn" id="btn-hide-project" title="Hide this repo from the colony — does not archive its threads">${ICON.eyeOff} Hide from colony</button>
      </div>
      <div class="checkouts"></div>
      <div class="threads-head"></div>
      <div class="threads"></div>
    </div>
  </div>
</aside>

<div class="rail panel">
  <button class="btn icon" id="btn-home" title="Reset the view (0)">${ICON.home}</button>
  <button class="btn icon" id="btn-next" title="Next bot waiting on you (N)">${ICON.next}</button>
  <div class="sep"></div>
  <button class="btn icon" id="btn-orbit" title="Orbit mode — sweep around the colony (O)" aria-pressed="false">${ICON.orbit}</button>
  <button class="btn icon" id="btn-planet" title="Change planet (Tab)">${ICON.globe}</button>
  <button class="btn icon" id="btn-time" title="Change the time of day (L)">${ICON.sun}</button>
  <div class="sep"></div>
  <button class="btn icon" id="btn-sound" title="Mute (M)" aria-pressed="true">${ICON.sound}</button>
</div>

<div class="settings panel closed" inert>
  <header>Settings <button class="btn icon ghost" id="btn-close-settings" title="Close">${ICON.close}</button></header>
  <div class="body"></div>
</div>

<div class="thread-pop panel">
  <i class="nib"></i>
  <div class="top">
    <div class="avatar"><canvas></canvas></div>
    <div class="info">
      <div class="title"></div>
      <div class="meta"></div>
    </div>
    <button class="btn icon ghost" id="btn-follow" title="Follow selected bot" aria-label="Follow selected bot" aria-pressed="false">${ICON.locate}</button>
    <button class="btn icon ghost" id="btn-deselect" title="Deselect (Esc)">${ICON.close}</button>
  </div>
  <div class="session-context"></div>
  <div class="session-location">
    <span class="session-path"></span>
    <span class="session-branch" hidden></span>
  </div>
  <p class="session-open-notice" hidden></p>
  <details class="session-details">
    <summary>Task details</summary>
    <dl class="session-details-body"></dl>
  </details>
  <button class="btn ghost session-parent" hidden></button>
  <div class="progress"><i></i></div>
  <div class="thread-actions">
    <button class="btn primary" id="btn-open" title="Open this thread in the harness it came from (Enter)">${ICON.open} Open</button>
    <button class="btn" id="btn-open-terminal">Resume in terminal</button>
    <button class="btn" id="btn-viewed" title="Stop this thread asking for you until it moves on again (V)">${ICON.eye} Viewed</button>
    <button class="btn" id="btn-archive" title="Archive — this bot walks back to the ship (A)">${ICON.archive} Archive</button>
  </div>
</div>

<div class="toasts"></div>
<div class="fps panel"></div>
<div class="hint-pill panel"></div>

<div class="help">
  <div class="sheet panel">
    <h2>Bot Crossing</h2>
    <p class="sub">Every coding-agent thread on this machine is a bot. They walk out of the ship, claim a plot for their repo, and build. Click one to open its thread; click a zone — its deck or its name — for the repo itself, and start a new conversation there. Hide a repo from that panel if you would rather not see it — its threads stay in your harness, and you can show it again from the list. Navigation works like Google Earth — drag the ground itself, right-drag to tilt, scroll to zoom in on whatever is under the cursor.</p>
    <div class="cols">
      <div>
        <div class="k"><span>Drag the ground</span><kbd>drag</kbd></div>
        <div class="k"><span>Tilt &amp; rotate</span><kbd>right-drag</kbd></div>
        <div class="k"><span>&nbsp;</span><kbd>⌃ or ⇧ + drag</kbd></div>
        <div class="k"><span>Zoom to cursor</span><kbd>scroll</kbd></div>
        <div class="k"><span>Move / zoom</span><kbd>arrows</kbd> <kbd>+ −</kbd></div>
        <div class="k"><span>Reset view</span><kbd>0</kbd></div>
        <div class="k"><span>Hide all UI</span><kbd>H</kbd> <kbd>${IS_MAC ? '⌘' : 'Ctrl'}\\</kbd></div>
        <div class="k"><span>Settings</span><kbd>S</kbd></div>
        <div class="k"><span>Screenshot</span><kbd>P</kbd></div>
      </div>
      <div>
        <div class="k"><span>Next needing you</span><kbd>N</kbd></div>
        <div class="k"><span>Open thread</span><kbd>Enter</kbd></div>
        <div class="k"><span>Mark viewed</span><kbd>V</kbd></div>
        <div class="k"><span>Archive</span><kbd>A</kbd></div>
        <div class="k"><span>New conversation</span><kbd>C</kbd></div>
        <div class="k"><span>Orbit mode</span><kbd>O</kbd></div>
        <div class="k"><span>Change planet</span><kbd>Tab</kbd></div>
        <div class="k"><span>Time of day</span><kbd>L</kbd></div>
        <div class="k"><span>Mute</span><kbd>M</kbd></div>
        <div class="k"><span>Deselect</span><kbd>Esc</kbd></div>
        <div class="k"><span>This sheet</span><kbd>?</kbd></div>
      </div>
    </div>
    <div style="margin-top:16px">
      <div class="legend-row"><i class="badge" style="background:#1a2b46;color:#8fb4ee">?</i> waiting on your reply — click to open the thread</div>
      <div class="legend-row"><i class="badge" style="background:#3d1c1c;color:#e88b8b">!</i> the session hit an error</div>
      <div class="legend-row"><i class="badge" style="background:#16301f;color:#7fd39a">⚒</i> running right now, building</div>
      <div class="legend-row"><i class="badge" style="background:#332b12;color:#e6c67f">✓</i> its pull request landed</div>
      <div class="legend-row"><i class="badge" style="background:#1d1f2e;color:#a9a8c0">z</i> nothing for three days</div>
    </div>
    <div style="margin-top:18px;display:flex;justify-content:flex-end">
      <button class="btn primary" id="btn-help-close">Got it</button>
    </div>
  </div>
</div>
`
