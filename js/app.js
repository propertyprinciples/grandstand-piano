import { createEngine } from "./audio.js"
import {
  EFFECTS,
  INSTRUMENTS,
  KEYS,
  KEY_BY_NOTE,
  PAGES,
  RHYTHMS,
  TEMPO_FACTORS,
  TEMPO_LABELS,
  playbackOf,
} from "./songs.js"

const audio = createEngine()
const spread = document.querySelector("#spread")
const deck = document.querySelector("#deck")
const veil = document.querySelector("#veil")
const songsEl = document.querySelector("#songs")
const lampsEl = document.querySelector("#lamps")
const instrumentsEl = document.querySelector("#instruments")
const rhythmsEl = document.querySelector("#rhythms")
const effectsEl = document.querySelector("#effects")
const keysEl = document.querySelector("#keys")
const dotsEl = document.querySelector("#dots")
const nowEl = document.querySelector("#now")
const tempoLabel = document.querySelector("#tempo-label")
const volumeInput = document.querySelector("#volume")
const beatEl = document.querySelector("#beat")
const sillyBtn = document.querySelector("[data-deck='silly']")

const state = {
  page: 0,
  instrument: "piano",
  rhythm: null,
  tempo: 2,
  baseBpm: 110,
  volume: 0.75,
  silly: false,
  sleeping: false,
  playing: false,
  activeId: null,
  samplesReady: false,
  waking: false,
}

const presses = { pennant: 0, ball: 0, charge: 0 }
const pressTimers = {}
let sleepTimer = 0
let playingEvents = []
let litIndex = -1
let litNote = null
const held = new Map()

audio.setHooks({
  getBpm: () => state.baseBpm * TEMPO_FACTORS[state.tempo],
  getInstrument: () => state.instrument,
  getSilly: () => state.silly,
  onHighlight: highlight,
  onStart: () => {
    state.playing = true
    state.sleeping = false
    veil.hidden = true
    clearTimeout(sleepTimer)
    paintStatus()
  },
  onMelodyDone: () => {
    state.playing = false
    litIndex = -1
    litNote = null
    paintLights()
    paintStatus()
    armSleep()
  },
  onHalted: () => {
    state.playing = false
    state.rhythm = null
    litIndex = -1
    litNote = null
    paintLights()
    paintDeck()
    if (!state.sleeping) armSleep()
  },
  onBeat: () => {
    beatEl.classList.add("flash")
    setTimeout(() => beatEl.classList.remove("flash"), 90)
  },
  onKeysReady: () => {
    state.samplesReady = true
    paintStatus()
  },
  onUnlock: () => {
    state.waking = true
    paintStatus()
  },
})

function armSleep() {
  clearTimeout(sleepTimer)
  sleepTimer = setTimeout(goSleep, 20000)
}

function poke() {
  if (state.sleeping) {
    state.sleeping = false
    veil.hidden = true
  }
  if (audio.isMelodyPlaying()) clearTimeout(sleepTimer)
  else armSleep()
}

function goSleep() {
  if (state.sleeping) return
  state.sleeping = true
  veil.hidden = false
  audio.stopAll()
}

function esc(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[char])
}

function person(x, y, shirt, skin, scale = 1) {
  return `<g transform="translate(${x} ${y}) scale(${scale})">
    <ellipse cx="0" cy="36" rx="14" ry="4" fill="rgba(0,0,0,.18)"/>
    <path d="M-8 14 h16 l-1 18 h-14z" fill="${shirt}"/>
    <path d="M-7 32 h5 l-1 14 h-4z M2 32 h5 l1 14 h-5z" fill="#243056"/>
    <circle cx="0" cy="4" r="8" fill="${skin}"/>
    <path d="M-8 3 q1 -12 9 -10 q7 1 8 7 q-3 -6 -9 -5 q-5 1 -8 8z" fill="${shirt}"/>
    <circle cx="-3" cy="4" r="1" fill="#1c2430"/>
    <circle cx="3" cy="4" r="1" fill="#1c2430"/>
  </g>`
}

function scene(id) {
  const scenes = {
    howto: `<svg class="scene" viewBox="0 0 760 168" role="img" aria-label="A row of colored piano keys on a ticket">
      <rect width="760" height="168" rx="16" fill="#243056"/>
      <rect x="36" y="28" width="688" height="112" rx="12" fill="#fff8ee"/>
      ${KEYS.map((key, i) => `<rect x="${70 + i * 78}" y="48" width="58" height="74" rx="8" fill="${key.color}"/>`).join("")}
    </svg>`,
    races: `<svg class="scene" viewBox="0 0 760 190" role="img" aria-label="Three runners on a track">
      <rect width="760" height="190" rx="16" fill="#1f6b45"/>
      <circle cx="680" cy="36" r="22" fill="#f0b429"/>
      <path d="M0 142 h760 v48 h-760z" fill="#c4a06a"/>
      <path d="M20 142 h720" stroke="#fff8ee" stroke-width="4" stroke-dasharray="14 12"/>
      <path d="M40 28 h28 l-8 16 h-12z" fill="#e23d3d"/>
      <path d="M78 22 h28 l-8 16 h-12z" fill="#f0b429"/>
      <path d="M116 30 h28 l-8 16 h-12z" fill="#2f86c7"/>
      ${person(180, 78, "#e23d3d", "#f3c7a1")}
      ${person(300, 70, "#f0b429", "#c68642", 1.05)}
      ${person(430, 82, "#2f86c7", "#8d552f")}
    </svg>`,
    boat: `<svg class="scene" viewBox="0 0 760 190" role="img" aria-label="Two rowers on a river">
      <rect width="760" height="190" rx="16" fill="#8ecae6"/>
      <path d="M0 120 q80 20 160 0 t160 0 t160 0 t160 0 t160 0 v70 h-800z" fill="#1d6f93"/>
      <path d="M0 138 q60 14 120 0 t120 0 t120 0 t120 0 t120 0 t120 0" fill="none" stroke="#d7f3ff" stroke-width="3"/>
      <g transform="translate(210 86)">
        <path d="M-70 28 q70 36 150 0 l-10 16 q-64 20 -130 0z" fill="#e7c27a"/>
        ${person(0, -20, "#e23d3d", "#f3c7a1", 0.85)}
        <path d="M-46 8 h120" stroke="#6b3f2a" stroke-width="4"/>
      </g>
      <g transform="translate(500 96)">
        <path d="M-70 28 q70 36 150 0 l-10 16 q-64 20 -130 0z" fill="#f4efe4"/>
        ${person(10, -24, "#2f9d57", "#8d552f", 0.85)}
        <path d="M-36 6 h110" stroke="#6b3f2a" stroke-width="4"/>
      </g>
    </svg>`,
    charge: `<svg class="scene" viewBox="0 0 760 190" role="img" aria-label="A court, a hoop, and a horn line">
      <rect width="760" height="190" rx="16" fill="#e7a33a"/>
      <rect x="40" y="30" width="250" height="130" rx="8" fill="#d08a28"/>
      <circle cx="250" cy="96" r="28" fill="none" stroke="#fff8ee" stroke-width="4"/>
      <rect x="248" y="40" width="6" height="56" fill="#fff8ee"/>
      ${person(360, 78, "#243056", "#f3c7a1")}
      ${person(470, 84, "#e23d3d", "#c68642")}
      ${person(580, 76, "#fff8ee", "#8d552f")}
      <path d="M392 78 h34 l8 8 h-46z" fill="#f0b429"/>
      <path d="M502 86 h34 l8 8 h-46z" fill="#f0b429"/>
      <path d="M612 74 h34 l8 8 h-46z" fill="#f0b429"/>
    </svg>`,
    crowd: `<svg class="scene" viewBox="0 0 760 190" role="img" aria-label="Clapping hands and falling confetti">
      <rect width="760" height="190" rx="16" fill="#f4efe4"/>
      <circle cx="250" cy="100" r="54" fill="#f0b429"/>
      <circle cx="250" cy="100" r="34" fill="#e07a14"/>
      <g fill="#d3542c">
        <rect x="150" y="70" width="46" height="64" rx="16" transform="rotate(-18 173 102)"/>
        <rect x="250" y="66" width="46" height="64" rx="16" transform="rotate(16 273 98)"/>
      </g>
      <rect x="520" y="36" width="10" height="18" fill="#e23d3d" transform="rotate(12 525 45)"/>
      <rect x="560" y="70" width="10" height="18" fill="#2f86c7" transform="rotate(-20 565 79)"/>
      <rect x="600" y="40" width="10" height="18" fill="#2f9d57"/>
      <rect x="640" y="88" width="10" height="18" fill="#f0b429" transform="rotate(18 645 97)"/>
      <rect x="80" y="40" width="10" height="18" fill="#3d4fd0" transform="rotate(-12 85 49)"/>
    </svg>`,
    match: `<svg class="scene" viewBox="0 0 760 190" role="img" aria-label="A football pitch with a ball">
      <rect width="760" height="190" rx="16" fill="#1f7a43"/>
      <rect x="36" y="24" width="688" height="142" fill="none" stroke="#fff8ee" stroke-width="3"/>
      <line x1="380" y1="24" x2="380" y2="166" stroke="#fff8ee" stroke-width="3"/>
      <circle cx="380" cy="95" r="28" fill="none" stroke="#fff8ee" stroke-width="3"/>
      <rect x="36" y="58" width="70" height="74" fill="none" stroke="#fff8ee" stroke-width="3"/>
      <rect x="654" y="58" width="70" height="74" fill="none" stroke="#fff8ee" stroke-width="3"/>
      <circle cx="250" cy="78" r="16" fill="#fff8ee"/>
      <path d="M250 70 a8 8 0 0 1 0 16" fill="none" stroke="#1c2430" stroke-width="2"/>
      ${person(180, 88, "#e23d3d", "#f3c7a1", 0.8)}
      ${person(560, 80, "#243056", "#c68642", 0.8)}
    </svg>`,
    ice: `<svg class="scene" viewBox="0 0 760 190" role="img" aria-label="Two skaters on an ice rink">
      <rect width="760" height="190" rx="16" fill="#d7eef5"/>
      <ellipse cx="380" cy="108" rx="280" ry="62" fill="#f7fcff" stroke="#7eb7c9" stroke-width="8"/>
      <path d="M180 108 q40 -18 80 0 t80 0" fill="none" stroke="#b9d7e2" stroke-width="2"/>
      <path d="M400 120 q36 16 76 -4 t70 8" fill="none" stroke="#b9d7e2" stroke-width="2"/>
      ${person(300, 62, "#2f86c7", "#f3c7a1", 0.9)}
      ${person(470, 70, "#e85a9b", "#8d552f", 0.9)}
    </svg>`,
    game: `<svg class="scene" viewBox="0 0 760 190" role="img" aria-label="A baseball diamond">
      <rect width="760" height="190" rx="16" fill="#87b86a"/>
      <path d="M380 150 L560 70 L380 20 L200 70 Z" fill="#c4a06a"/>
      <rect x="366" y="138" width="18" height="18" fill="#fff8ee" transform="rotate(12 375 147)"/>
      <rect x="548" y="60" width="16" height="16" fill="#fff8ee"/>
      <rect x="368" y="12" width="16" height="16" fill="#fff8ee"/>
      <rect x="192" y="60" width="16" height="16" fill="#fff8ee"/>
      ${person(250, 96, "#243056", "#c68642", 0.9)}
      <path d="M268 118 l46 -28" stroke="#6b3f2a" stroke-width="5" stroke-linecap="round"/>
      <circle cx="620" cy="40" r="14" fill="#f4efe4" stroke="#e23d3d" stroke-width="3"/>
    </svg>`,
  }
  return scenes[id] || ""
}

const ICONS = {
  surprise: `<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="12" fill="none" stroke="currentColor" stroke-width="2"/><text x="16" y="21" text-anchor="middle" font-size="16" font-family="Outfit, sans-serif" fill="currentColor">?</text></svg>`,
  trumpet: `<svg viewBox="0 0 32 32"><path d="M4 14 h12 l6 -4 v12 l-6 -4 h-12z" fill="currentColor"/><circle cx="25" cy="16" r="3" fill="none" stroke="currentColor" stroke-width="2"/></svg>`,
  guitar: `<svg viewBox="0 0 32 32"><circle cx="18" cy="20" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M22 14 L12 4" stroke="currentColor" stroke-width="2"/><circle cx="16" cy="20" r="2" fill="currentColor"/></svg>`,
  flute: `<svg viewBox="0 0 32 32"><rect x="3" y="14" width="26" height="5" rx="2" fill="currentColor"/><circle cx="10" cy="16" r="1.2" fill="#2a1a15"/><circle cx="16" cy="16" r="1.2" fill="#2a1a15"/><circle cx="22" cy="16" r="1.2" fill="#2a1a15"/></svg>`,
  saxophone: `<svg viewBox="0 0 32 32"><path d="M20 4 v12 a6 6 0 1 1 -8 0" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="24" r="4" fill="currentColor"/></svg>`,
  drums: `<svg viewBox="0 0 32 32"><ellipse cx="12" cy="20" rx="8" ry="4" fill="none" stroke="currentColor" stroke-width="2"/><ellipse cx="20" cy="14" rx="7" ry="3.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>`,
  piano: `<svg viewBox="0 0 32 32"><rect x="4" y="8" width="24" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10 8 v10 M16 8 v10 M22 8 v10" stroke="currentColor" stroke-width="2"/></svg>`,
  march: `<svg viewBox="0 0 32 32"><path d="M8 24 V8 M8 12 h8 l4 4 h6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>`,
  star: `<svg viewBox="0 0 32 32"><path d="M16 4 l3 8 h8 l-6 5 2 8 -7 -4 -7 4 2 -8 -6 -5 h8z" fill="currentColor"/></svg>`,
  jazzy: `<svg viewBox="0 0 32 32"><path d="M8 22 c6 -12 10 -12 16 -2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="10" cy="20" r="2" fill="currentColor"/><circle cx="22" cy="14" r="2" fill="currentColor"/></svg>`,
  dance: `<svg viewBox="0 0 32 32"><circle cx="16" cy="8" r="3" fill="currentColor"/><path d="M16 11 l-6 8 M16 14 l8 4 M12 20 l-2 8 M18 20 l4 8" stroke="currentColor" stroke-width="2" fill="none"/></svg>`,
  clap: `<svg viewBox="0 0 32 32"><path d="M8 18 q4 -8 8 0 q4 -8 8 0 v6 q-8 6 -16 0z" fill="currentColor"/></svg>`,
  boing: `<svg viewBox="0 0 32 32"><path d="M6 22 q6 -16 10 0 q4 -10 10 0" fill="none" stroke="currentColor" stroke-width="2"/></svg>`,
  whistle: `<svg viewBox="0 0 32 32"><path d="M4 16 h14 l8 -5 v10 l-8 -5z" fill="currentColor"/></svg>`,
  sparkle: `<svg viewBox="0 0 32 32"><path d="M16 4 l2 8 8 2 -8 2 -2 8 -2 -8 -8 -2 8 -2z" fill="currentColor"/></svg>`,
  pennant: `<svg viewBox="0 0 32 32"><path d="M8 4 v24" stroke="currentColor" stroke-width="2"/><path d="M10 6 h12 l-4 6 4 6 h-12z" fill="currentColor"/></svg>`,
  ball: `<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="10" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 6 v20 M6 16 h20 M9 9 q7 4 0 14 M23 9 q-7 4 0 14" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`,
  horn: `<svg viewBox="0 0 32 32"><path d="M6 14 h10 l8 -6 v16 l-8 -6 h-10z" fill="currentColor"/></svg>`,
}

function icon(name) {
  return ICONS[name] || ""
}

function currentPage() {
  return PAGES[state.page]
}

function mount() {
  songsEl.innerHTML = [
    buttonSong("pennant", "Pennant", "pennant", true),
    buttonSong("ball", "Ball", "ball", true),
    buttonSong("charge", "Horn", "horn", false),
  ].join("")

  lampsEl.innerHTML = TEMPO_LABELS.map(() => "<span></span>").join("")
  instrumentsEl.innerHTML = INSTRUMENTS.map((item) => choice("instrument", item.id, item.label)).join("")
  rhythmsEl.innerHTML = RHYTHMS.map((item) => choice("rhythm", item.id, item.label)).join("")
  effectsEl.innerHTML = EFFECTS.map((item) => choice("sfx", item.id, item.label)).join("")
  keysEl.innerHTML = KEYS.map((key) => `
    <button class="key" type="button" data-note="${key.note}" style="--c:${key.color}" aria-label="${key.label}">
      <b>${esc(key.label)}</b>
      <small>${esc(key.computer)}</small>
    </button>`).join("")
  dotsEl.innerHTML = PAGES.map((page, index) => `
    <button type="button" data-page="${index}" aria-label="${esc(page.title)}"></button>`).join("")

  renderPage()
  paintDeck()
  armSleep()
}

function buttonSong(group, label, glyph, counted) {
  const meta = counted
    ? `<span class="pips" aria-hidden="true"><i></i><i></i><i></i></span>`
    : `<small>One call</small>`
  return `<button class="song" type="button" data-group="${group}" aria-label="${label} song button">
    ${icon(glyph)}
    <strong>${label}</strong>
    ${meta}
  </button>`
}

function choice(kind, id, label) {
  return `<button class="choice" type="button" data-kind="${kind}" data-id="${id}" aria-pressed="false">
    ${icon(id)}
    <span>${esc(label)}</span>
  </button>`
}

function renderPage() {
  const page = currentPage()
  spread.style.setProperty("--accent", page.accent)
  if (page.tips) {
    spread.innerHTML = `
      ${scene(page.scene)}
      <p class="kicker">${esc(page.kicker)}</p>
      <h2>${esc(page.title)}</h2>
      <div class="tips">
        ${page.tips.map((tip) => `<article><h3>${esc(tip.title)}</h3><p>${esc(tip.body)}</p></article>`).join("")}
      </div>`
  } else {
    const events = playbackOf(page)
    const chips = [
      { label: page.playLabel || "Play this tune", action: "play", play: true },
      ...page.actions,
    ]
    spread.innerHTML = `
      ${scene(page.scene)}
      <p class="kicker">${esc(page.kicker)}</p>
      <h2>${esc(page.title)}</h2>
      <p class="tune">Tune · ${esc(page.tune)}</p>
      <div class="chips">
        ${chips.map((chip) => `<button type="button" class="${chip.play ? "play" : ""}" data-action="${esc(chip.action)}" data-value="${esc(chip.value || "")}">${esc(chip.label)}</button>`).join("")}
      </div>
      <div class="staff">
        ${staffHtml(page, events)}
      </div>`
  }
  dotsEl.querySelectorAll("button").forEach((button, index) => {
    button.setAttribute("aria-current", index === state.page ? "true" : "false")
    button.style.setProperty("--accent", page.accent)
  })
  paintLights()
}

function staffHtml(page, events) {
  let html = ""
  let line = []
  const flush = () => {
    if (!line.length) return
    html += `<div class="staff-line">${line.join("")}</div>`
    line = []
  }
  events.forEach((event, index) => {
    if (event.hidden) {
      flush()
      return
    }
    if (!event.note && event.sfx) {
      line.push(`<button class="note clap" type="button" data-event="${index}" data-sfx="${esc(event.sfx)}" aria-label="Clap"><b>👏</b><small>${esc(event.lyric || "")}</small></button>`)
      return
    }
    const key = KEY_BY_NOTE[event.note]
    line.push(`<button class="note" type="button" data-event="${index}" data-pitch="${esc(event.note)}" style="--c:${key.color}" aria-label="${esc(key.label)} ${esc(event.lyric)}"><b>${esc(key.label)}</b><small>${esc(event.lyric)}</small></button>`)
  })
  flush()
  return html
}

function paintDeck() {
  const page = currentPage()
  document.querySelectorAll(".song").forEach((button) => {
    const group = button.dataset.group
    button.classList.toggle("is-current", page.group === group)
    button.querySelectorAll(".pips i").forEach((pip, index) => {
      pip.classList.toggle("on", index < presses[group])
    })
  })
  lampsEl.querySelectorAll("span").forEach((lamp, index) => {
    lamp.classList.toggle("on", index <= state.tempo)
  })
  tempoLabel.textContent = TEMPO_LABELS[state.tempo]
  document.querySelectorAll(".choice").forEach((button) => {
    const on = (button.dataset.kind === "instrument" && button.dataset.id === state.instrument)
      || (button.dataset.kind === "rhythm" && button.dataset.id === state.rhythm)
    button.setAttribute("aria-pressed", on ? "true" : "false")
  })
  sillyBtn.setAttribute("aria-pressed", state.silly ? "true" : "false")
  volumeInput.value = String(Math.round(state.volume * 100))
  paintStatus()
}

function paintStatus() {
  const active = PAGES.find((page) => page.id === state.activeId)
  if (state.waking && !state.samplesReady && !state.playing) {
    nowEl.textContent = "Loading the keyboard…"
    return
  }
  if (state.playing && active?.tune) {
    nowEl.textContent = `Playing · ${active.tune}`
    return
  }
  if (state.rhythm) {
    const rhythm = RHYTHMS.find((item) => item.id === state.rhythm)
    nowEl.textContent = `Beat · ${rhythm.label}`
    return
  }
  nowEl.textContent = "Tap a song button, or play the keys."
}

function highlight(index) {
  if (index === litIndex && (index < 0 || playingEvents[index]?.note === litNote)) return
  litIndex = index
  litNote = index >= 0 ? playingEvents[index]?.note || null : null
  paintLights()
}

function paintLights() {
  keysEl.querySelectorAll(".key").forEach((key) => {
    key.classList.toggle("is-lit", Boolean(litNote) && key.dataset.note === litNote)
  })
  spread.querySelectorAll(".note").forEach((note) => note.classList.remove("is-on"))
  if (litIndex < 0 || currentPage().id !== state.activeId) return
  spread.querySelector(`[data-event="${litIndex}"]`)?.classList.add("is-on")
}

function setInstrument(id) {
  state.instrument = id
  paintDeck()
}

function setRhythm(id) {
  if (state.rhythm === id) {
    state.rhythm = null
    audio.stopRhythm()
  } else {
    state.rhythm = id
    audio.startRhythm(id)
  }
  paintDeck()
}

function setTempo(step) {
  state.tempo = Math.min(TEMPO_FACTORS.length - 1, Math.max(0, step))
  paintDeck()
}

function setVolume(value) {
  state.volume = Math.min(1, Math.max(0, value))
  audio.setVolume(state.volume)
  paintDeck()
}

function playPage(page) {
  state.page = PAGES.indexOf(page)
  state.instrument = page.instrument
  state.rhythm = page.rhythm
  state.tempo = page.tempo
  state.baseBpm = page.bpm
  state.silly = Boolean(page.silly)
  state.activeId = page.id
  presses[page.group] = page.press
  window.clearTimeout(pressTimers[page.group])
  pressTimers[page.group] = window.setTimeout(() => {
    presses[page.group] = 0
    paintDeck()
  }, 2200)
  if (page.rhythm) audio.startRhythm(page.rhythm)
  else audio.stopRhythm()
  playingEvents = playbackOf(page)
  litIndex = -2
  renderPage()
  paintDeck()
  audio.playMelody(playingEvents)
}

function pressGroup(group) {
  poke()
  if (group === "charge") {
    playPage(PAGES.find((page) => page.id === "charge"))
    return
  }
  const next = presses[group] >= 3 ? 1 : presses[group] + 1
  presses[group] = next
  const page = PAGES.find((item) => item.group === group && item.press === next)
  playPage(page)
}

function runAction(action, value) {
  audio.unlock()
  poke()
  const page = currentPage()
  if (action === "play" && page.lines) {
    playPage(page)
    return
  }
  if (action === "tempoUp") setTempo(state.tempo + 1)
  if (action === "tempoDown") setTempo(state.tempo - 1)
  if (action === "instrument") setInstrument(value)
  if (action === "rhythm") {
    state.rhythm = null
    setRhythm(value)
  }
  if (action === "silly") {
    state.silly = true
    paintDeck()
  }
  if (action === "sfx") audio.playSfx(value)
  if (action === "mix") {
    state.instrument = "surprise"
    state.silly = true
    const order = RHYTHMS.map((item) => item.id)
    const index = order.indexOf(state.rhythm)
    setRhythm(order[(index + 1) % order.length])
  }
  if (action === "rock") {
    state.instrument = "guitar"
    state.tempo = TEMPO_FACTORS.length - 1
    state.rhythm = null
    setRhythm("star")
  }
}

function go(delta) {
  poke()
  state.page = (state.page + delta + PAGES.length) % PAGES.length
  renderPage()
  paintDeck()
}

function refreshHeldKeys() {
  const down = new Set([...held.values()].map((entry) => entry.note))
  keysEl.querySelectorAll(".key").forEach((key) => {
    key.classList.toggle("is-down", down.has(key.dataset.note))
  })
}

function pressKey(note, pointerId) {
  poke()
  releaseKey(pointerId)
  const stop = audio.startNote(note, state.instrument)
  held.set(pointerId, { stop, note })
  refreshHeldKeys()
}

function releaseKey(pointerId) {
  const entry = held.get(pointerId)
  if (!entry) return
  entry.stop()
  held.delete(pointerId)
  refreshHeldKeys()
}

const KEYMAP = Object.fromEntries(KEYS.map((key) => [key.computer.toLowerCase(), key.note]))

for (const type of ["touchstart", "touchend", "pointerdown"]) {
  window.addEventListener(type, () => audio.unlock(), { capture: true, passive: true })
}

deck.addEventListener("pointerdown", () => {
  audio.unlock()
  poke()
}, true)

deck.addEventListener("click", (event) => {
  const song = event.target.closest("[data-group]")
  if (song) {
    pressGroup(song.dataset.group)
    return
  }
  const choiceBtn = event.target.closest(".choice")
  if (choiceBtn) {
    poke()
    const { kind, id } = choiceBtn.dataset
    if (kind === "instrument") setInstrument(id)
    if (kind === "rhythm") setRhythm(id)
    if (kind === "sfx") audio.playSfx(id)
    return
  }
  const deckBtn = event.target.closest("[data-deck]")
  if (!deckBtn) return
  const action = deckBtn.dataset.deck
  if (action === "tempoUp") setTempo(state.tempo + 1)
  if (action === "tempoDown") setTempo(state.tempo - 1)
  if (action === "volUp") setVolume(state.volume + 0.1)
  if (action === "volDown") setVolume(state.volume - 0.1)
  if (action === "silly") {
    state.silly = !state.silly
    paintDeck()
  }
  if (action === "stop") audio.stopAll()
})

volumeInput.addEventListener("input", () => {
  poke()
  setVolume(Number(volumeInput.value) / 100)
})

keysEl.addEventListener("pointerdown", (event) => {
  const key = event.target.closest(".key")
  if (!key) return
  event.preventDefault()
  key.setPointerCapture?.(event.pointerId)
  pressKey(key.dataset.note, event.pointerId)
})

keysEl.addEventListener("pointerup", (event) => releaseKey(event.pointerId))
keysEl.addEventListener("pointercancel", (event) => releaseKey(event.pointerId))
keysEl.addEventListener("contextmenu", (event) => event.preventDefault())

spread.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-action]")
  if (chip) runAction(chip.dataset.action, chip.dataset.value)
})

spread.addEventListener("pointerdown", (event) => {
  const note = event.target.closest(".note")
  if (!note) return
  poke()
  audio.unlock()
  if (note.dataset.pitch) {
    const stop = audio.startNote(note.dataset.pitch, state.instrument)
    setTimeout(stop, 180)
  } else if (note.dataset.sfx) {
    audio.playSfx(note.dataset.sfx)
  }
})

document.querySelector("#prev").addEventListener("click", () => go(-1))
document.querySelector("#next").addEventListener("click", () => go(1))
dotsEl.addEventListener("click", (event) => {
  const button = event.target.closest("[data-page]")
  if (!button) return
  poke()
  state.page = Number(button.dataset.page)
  renderPage()
  paintDeck()
})

let swipeX = null
let swipeOnControl = false
spread.addEventListener("pointerdown", (event) => {
  swipeX = event.clientX
  swipeOnControl = Boolean(event.target.closest("button"))
})
spread.addEventListener("pointerup", (event) => {
  if (swipeX == null || swipeOnControl) return
  const delta = event.clientX - swipeX
  if (Math.abs(delta) > 60) go(delta < 0 ? 1 : -1)
  swipeX = null
})

window.addEventListener("keydown", (event) => {
  if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return
  const note = KEYMAP[event.key.toLowerCase()]
  if (note) {
    event.preventDefault()
    pressKey(note, `key:${event.key}`)
    return
  }
  if (event.target.matches("input")) return
  if (event.key === "ArrowRight") {
    event.preventDefault()
    go(1)
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault()
    go(-1)
  }
  if (event.code === "Space" && event.target === document.body) {
    event.preventDefault()
    poke()
    audio.stopAll()
  }
})

window.addEventListener("keyup", (event) => {
  releaseKey(`key:${event.key}`)
})

mount()
audio.setVolume(state.volume)
