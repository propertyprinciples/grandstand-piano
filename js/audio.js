const SEMI = { C: 0, Cs: 1, D: 2, Ds: 3, E: 4, F: 5, Fs: 6, G: 7, A: 9, As: 10, B: 11 }
const VOICES = ["piano", "trumpet", "guitar", "flute", "saxophone", "drums"]

// Recorded notes. Piano, trumpet, flute, and sax are Versilian (CC BY 3.0).
// Guitar is the University of Iowa set shared as CC BY 3.0. Drums are FluidR3 (CC BY 3.0).
const LIBRARY = {
  piano: ["C4", "Cs4", "D4", "E4", "F4", "G4", "A4", "B4", "C5"],
  guitar: ["C4", "Cs4", "D4", "E4", "F4", "G4", "A4", "B4", "C5"],
  saxophone: ["C4", "Cs4", "D4", "E4", "F4", "G4", "A4", "B4", "C5"],
  trumpet: ["C4", "Ds4", "F4", "G4", "As4", "D5"],
  flute: ["C4", "E4", "A4", "C5"],
  drums: ["C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5"],
}

const PEAK = { piano: 0.9, guitar: 0.82, trumpet: 0.6, flute: 0.55, saxophone: 0.58, drums: 0.9 }
const OFFSET = { flute: 0.22 }
const pageStart = performance.now() / 1000

function isIOSDevice() {
  const ua = navigator.userAgent || ""
  return /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
}

const cache = {}
const gate = {}
for (const inst of Object.keys(LIBRARY)) {
  cache[inst] = {}
  let resolve
  const promise = new Promise((done) => { resolve = done })
  gate[inst] = { promise, resolve, done: false }
}

function finishGate(inst) {
  if (gate[inst].done) return
  gate[inst].done = true
  gate[inst].resolve()
}

function loadRecordings() {
  const jobs = []
  for (const [inst, notes] of Object.entries(LIBRARY)) {
    for (const note of notes) jobs.push({ inst, note })
  }
  const results = []
  let cursor = 0
  async function worker() {
    while (cursor < jobs.length) {
      const job = jobs[cursor]
      cursor += 1
      try {
        const response = await fetch(`samples/${job.inst}/${job.note}.mp3`)
        if (!response.ok) continue
        results.push({ inst: job.inst, note: job.note, buf: await response.arrayBuffer() })
      } catch { /* a missing file falls back to the nearest note */ }
    }
  }
  return Promise.all([worker(), worker(), worker(), worker()]).then(() => results)
}

const fetched = loadRecordings()

export function noteFreq(note) {
  const midi = midiOf(note)
  if (midi == null) return null
  return 440 * 2 ** ((midi - 69) / 12)
}

function midiOf(note) {
  const match = /^([A-G])(s)?(\d)$/.exec(note || "")
  if (!match) return null
  return (Number(match[3]) + 1) * 12 + SEMI[match[1] + (match[2] || "")]
}

export function createEngine() {
  let ctx = null
  let master = null
  let melodyBus = null
  let rhythmBus = null
  let sfxBus = null
  const live = new Set()
  let melodyToken = 0
  let rhythmToken = 0
  let melodyTimer = 0
  let rhythmTimer = 0
  let highlightRaf = 0
  let melodyPlaying = false
  let rhythmOn = false
  let volume = 0.75
  let keysReady = false
  let decodePromise = null
  let primed = false
  let unlocked = false
  const ios = isIOSDevice()
  const htmlLive = new Set()
  const htmlPool = []

  const hooks = {
    getBpm: () => 110,
    getInstrument: () => "piano",
    getSilly: () => false,
    onHighlight: () => {},
    onStart: () => {},
    onMelodyDone: () => {},
    onHalted: () => {},
    onBeat: () => {},
    onKeysReady: () => {},
    onUnlock: () => {},
  }

  function setHooks(next) {
    Object.assign(hooks, next)
    if (keysReady) hooks.onKeysReady()
  }

  function ensure() {
    if (ctx) return
    const AudioCtx = window.AudioContext || window.webkitAudioContext
    try {
      ctx = new AudioCtx()
    } catch {
      ctx = new AudioCtx()
    }
    master = ctx.createGain()
    master.gain.value = volume
    melodyBus = ctx.createGain()
    rhythmBus = ctx.createGain()
    sfxBus = ctx.createGain()
    melodyBus.gain.value = 0.95
    rhythmBus.gain.value = 0.42
    sfxBus.gain.value = 0.7
    melodyBus.connect(master)
    rhythmBus.connect(master)
    sfxBus.connect(master)
    // iPhone Safari silences the whole graph when a compressor is in it.
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent)
      || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    if (ios) {
      master.connect(ctx.destination)
      return
    }
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -12
    comp.knee.value = 8
    comp.ratio.value = 2.2
    comp.attack.value = 0.008
    comp.release.value = 0.18
    master.connect(comp)
    comp.connect(ctx.destination)
  }

  function markKeysReady() {
    if (keysReady || !gate.piano.done) return
    keysReady = true
    hooks.onKeysReady()
  }

  function decodeBuffer(buf) {
    const copy = buf.slice(0)
    return new Promise((resolve, reject) => {
      ctx.decodeAudioData(copy, resolve, reject)
    })
  }

  async function decodeNote(inst, note) {
    if (cache[inst]?.[note]) return
    const items = await fetched
    const item = items.find((entry) => entry.inst === inst && entry.note === note)
    if (!item?.buf || !ctx) return
    try {
      cache[inst][note] = await decodeBuffer(item.buf)
      item.buf = null
    } catch { /* the nearest decoded note covers a bad file */ }
  }

  function decodeAll() {
    if (decodePromise) return decodePromise
    ensure()
    decodePromise = (async () => {
      if (ctx.state !== "running") {
        try { await ctx.resume() } catch { /* the tap already asked it to run */ }
      }
      const items = await fetched
      const order = ["piano", "guitar", "trumpet", "flute", "saxophone", "drums"]
      for (const inst of order) {
        const notes = items.filter((item) => item.inst === inst)
        for (let i = 0; i < notes.length; i += 2) {
          await Promise.all(notes.slice(i, i + 2).map(async (item) => {
            if (!item.buf || cache[inst][item.note]) return
            try {
              cache[inst][item.note] = await decodeBuffer(item.buf)
              item.buf = null
            } catch { /* skip a bad file; the nearest note covers it */ }
          }))
        }
        finishGate(inst)
        markKeysReady()
      }
    })().catch(() => {
      for (const inst of Object.keys(LIBRARY)) finishGate(inst)
      markKeysReady()
    })
    return decodePromise
  }

  function clock() {
    if (!ios && ctx) return ctx.currentTime
    return performance.now() / 1000 - pageStart
  }

  function sampleFile(inst, note) {
    const names = LIBRARY[inst] || LIBRARY.piano
    const target = midiOf(note)
    let best = names[0]
    let bestDist = 99
    for (const name of names) {
      const dist = Math.abs(midiOf(name) - target)
      if (dist < bestDist) {
        bestDist = dist
        best = name
      }
    }
    return { url: `samples/${inst}/${best}.mp3`, rate: 2 ** ((target - midiOf(best)) / 12) }
  }

  function takePlayer() {
    const free = htmlPool.find((el) => el.paused || el.dataset.priming === "1")
    if (free) {
      delete free.dataset.priming
      return free
    }
    const el = document.createElement("audio")
    el.setAttribute("playsinline", "")
    el.setAttribute("webkit-playsinline", "")
    el.preload = "auto"
    el.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none"
    document.body.appendChild(el)
    htmlPool.push(el)
    return el
  }

  function primePlayers() {
    if (primed) return
    primed = true
    for (let i = 0; i < 6; i++) takePlayer()
    for (const el of htmlPool) {
      el.src = "samples/piano/C4.mp3"
      el.volume = 0.01
      el.dataset.priming = "1"
      const pending = el.play()
      if (pending && pending.then) {
        pending.then(() => {
          if (el.dataset.priming !== "1") return
          el.pause()
          try { el.currentTime = 0 } catch { /* not seekable yet */ }
        }).catch(() => {})
      }
    }
    if (!keysReady) {
      keysReady = true
      hooks.onKeysReady()
    }
  }

  function htmlLevel(inst) {
    return Math.max(0, Math.min(1, (PEAK[inst] || 0.8) * volume))
  }

  function startHtml(inst, note, length, busName) {
    const picked = sampleFile(inst, note)
    const el = takePlayer()
    if (!el.src.endsWith(`/${inst}/${picked.url.split("/").pop()}`)) el.src = picked.url
    try { el.preservesPitch = false } catch { /* older Safari */ }
    try { el.webkitPreservesPitch = false } catch { /* older Safari */ }
    el.playbackRate = picked.rate
    el.volume = htmlLevel(inst)
    try { el.currentTime = inst === "flute" ? 0.22 : 0 } catch { /* seek after play */ }
    const handle = {
      bus: busName,
      el,
      stop() {
        htmlLive.delete(handle)
        clearTimeout(handle.timer)
        el.pause()
      },
    }
    htmlLive.add(handle)
    const pending = el.play()
    if (pending && pending.catch) pending.catch(() => {})
    if (length > 0) handle.timer = setTimeout(() => handle.stop(), length * 1000)
    return handle
  }

  function playHtml(inst, note, time, length, busName) {
    const delay = Math.max(0, (time - clock()) * 1000)
    let inner = null
    let timer = 0
    const handle = {
      bus: busName,
      stop() {
        htmlLive.delete(handle)
        clearTimeout(timer)
        inner?.stop()
      },
    }
    htmlLive.add(handle)
    const begin = () => {
      inner = startHtml(inst, note, length, busName)
    }
    if (delay < 30) begin()
    else timer = setTimeout(begin, delay)
    return handle
  }

  function unlock() {
    if (ios) {
      primePlayers()
      if (!unlocked) {
        unlocked = true
        try { hooks.onUnlock() } catch { /* status line can update later */ }
      }
      return
    }
    ensure()
    if (ctx.state !== "running") {
      const pending = ctx.resume()
      if (pending && pending.catch) pending.catch(() => {})
    }
    if (!primed) {
      primed = true
      const buffer = ctx.createBuffer(1, 1, ctx.sampleRate)
      const blip = ctx.createBufferSource()
      blip.buffer = buffer
      blip.connect(master)
      try { blip.start() } catch { /* already running */ }
    }
    decodeAll()
    if (!unlocked) {
      unlocked = true
      try { hooks.onUnlock() } catch { /* the status line can update later */ }
    }
  }

  function whenReady(inst) {
    decodeAll()
    return gate[inst]?.promise || Promise.resolve()
  }

  function setVolume(value) {
    volume = Math.min(1, Math.max(0, value))
    if (master && ctx) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.02)
    for (const handle of htmlLive) handle.el.volume = Math.max(0, Math.min(1, handle.el.volume))
  }

  function tag(node, bus) {
    node.__bus = bus
    live.add(node)
    return node
  }

  function killBus(bus) {
    for (const handle of [...htmlLive]) {
      if (handle.bus === bus) handle.stop()
    }
    for (const node of [...live]) {
      if (node.__bus !== bus) continue
      try { node.__cut?.() } catch { /* already silent */ }
      try { node.stop?.() } catch { /* already stopped */ }
      try { node.disconnect?.() } catch { /* already gone */ }
      live.delete(node)
    }
  }

  function busOf(name) {
    if (name === "rhythm") return rhythmBus
    if (name === "sfx") return sfxBus
    return melodyBus
  }

  function nearest(inst, note) {
    const bank = cache[inst]
    const target = midiOf(note)
    if (!bank || target == null) return null
    let best = null
    let bestDist = 99
    for (const name of Object.keys(bank)) {
      const dist = Math.abs(midiOf(name) - target)
      if (dist < bestDist) {
        bestDist = dist
        best = name
      }
    }
    if (!best || bestDist > 4) return null
    return { buffer: bank[best], rate: 2 ** ((target - midiOf(best)) / 12) }
  }

  function spawn(inst, note, time, busName) {
    const hit = nearest(inst, note)
    if (!hit) return null
    const src = tag(ctx.createBufferSource(), busName)
    const gain = tag(ctx.createGain(), busName)
    src.buffer = hit.buffer
    src.playbackRate.setValueAtTime(hit.rate, time)
    const offset = Math.min(OFFSET[inst] || 0, Math.max(0, hit.buffer.duration - 0.35))
    const peak = PEAK[inst] || 0.7
    if (offset > 0) {
      gain.gain.setValueAtTime(0.0001, time)
      gain.gain.exponentialRampToValueAtTime(peak, time + 0.03)
    } else {
      gain.gain.setValueAtTime(peak, time)
    }
    src.connect(gain)
    gain.connect(busOf(busName))
    try {
      src.start(time, offset)
    } catch {
      try { src.start() } catch { return null }
    }
    src.onended = () => {
      live.delete(src)
      live.delete(gain)
      try { src.disconnect() } catch { /* already gone */ }
      try { gain.disconnect() } catch { /* already gone */ }
    }
    src.__cut = () => {
      const at = ctx.currentTime
      try {
        gain.gain.cancelScheduledValues(at)
        gain.gain.setValueAtTime(0.0001, at)
      } catch { /* gain already closed */ }
    }
    return { src, gain, peak }
  }

  function scheduleFade(voice, time, length, release) {
    const end = time + Math.max(0.05, length)
    const from = Math.max(time + 0.031, end)
    voice.gain.gain.setValueAtTime(voice.peak, from)
    voice.gain.gain.exponentialRampToValueAtTime(0.0001, from + release)
    try { voice.src.stop(from + release + 0.03) } catch { /* already stopped */ }
  }

  function playSample(inst, note, time, length, busName) {
    if (ios) {
      playHtml(inst, note, time, length + (inst === "guitar" ? 0.34 : 0.16), busName)
      return
    }
    const voice = spawn(inst, note, time, busName)
    if (!voice) {
      fallback(noteFreq(note), time, length, busName)
      return
    }
    const release = inst === "guitar" ? 0.34 : inst === "piano" ? 0.16 : inst === "drums" ? 0.1 : 0.08
    const min = inst === "guitar" ? 0.28 : 0.06
    scheduleFade(voice, time, Math.max(min, length), release)
  }

  function holdSample(inst, note, busName) {
    if (ios) {
      const plucked = inst === "guitar" || inst === "drums"
      const handle = startHtml(inst, note, plucked ? (inst === "guitar" ? 2.1 : 0.5) : 0, busName)
      if (plucked) return { release() {} }
      return { release() { handle.stop() } }
    }
    const now = ctx.currentTime
    const voice = spawn(inst, note, now, busName)
    if (!voice) {
      fallback(noteFreq(note), now, 0.35, busName)
      return { release() {} }
    }
    const plucked = inst === "guitar" || inst === "drums"
    if (plucked) {
      scheduleFade(voice, now, inst === "guitar" ? 1.7 : 0.34, inst === "guitar" ? 0.4 : 0.12)
      return { release() {} }
    }
    let released = false
    return {
      release() {
        if (released) return
        released = true
        const at = ctx.currentTime
        const fade = inst === "piano" ? 0.08 : 0.1
        try {
          voice.gain.gain.cancelScheduledValues(at)
          voice.gain.gain.setValueAtTime(Math.max(0.0001, voice.gain.gain.value), at)
          voice.gain.gain.exponentialRampToValueAtTime(0.0001, at + fade)
          voice.src.stop(at + fade + 0.02)
        } catch { /* already ended */ }
      },
    }
  }

  function fallback(freq, time, dur, busName) {
    if (!freq) return
    const osc = tag(ctx.createOscillator(), busName)
    osc.type = "triangle"
    osc.frequency.setValueAtTime(freq, time)
    const gain = tag(ctx.createGain(), busName)
    gain.gain.setValueAtTime(0.0001, time)
    gain.gain.exponentialRampToValueAtTime(0.1, time + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + Math.max(0.18, dur))
    osc.connect(gain)
    gain.connect(busOf(busName))
    osc.start(time)
    osc.stop(time + Math.max(0.2, dur) + 0.02)
  }

  function voice(instrument, note, time, dur, busName) {
    const id = instrument === "surprise" ? VOICES[(Math.random() * VOICES.length) | 0] : instrument
    const length = id === "guitar" ? Math.max(dur, 0.36) : id === "piano" ? Math.max(dur * 0.9, 0.1) : dur
    playSample(id, note, time, length, busName)
  }

  function env(busName, time, peak, attack, release) {
    const gain = tag(ctx.createGain(), busName)
    gain.gain.setValueAtTime(0.0001, time)
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0001), time + attack)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + attack + release)
    gain.connect(busOf(busName))
    return gain
  }

  function noiseBuffer(seconds) {
    const length = Math.max(1, Math.floor(ctx.sampleRate * seconds))
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1
    return buffer
  }

  function burst(time, busName, seconds, frequency, peak, release) {
    const source = tag(ctx.createBufferSource(), busName)
    source.buffer = noiseBuffer(seconds)
    const filter = tag(ctx.createBiquadFilter(), busName)
    filter.type = "bandpass"
    filter.frequency.value = frequency
    filter.Q.value = 0.8
    const gain = env(busName, time, peak, 0.004, release)
    source.connect(filter)
    filter.connect(gain)
    source.start(time)
    source.stop(time + seconds)
  }

  function playClap(time, busName) {
    burst(time, busName, 0.08, 1400, 0.32, 0.09)
    burst(time + 0.012, busName, 0.06, 1800, 0.18, 0.07)
  }

  function playBoing(time, busName) {
    const osc = tag(ctx.createOscillator(), busName)
    osc.type = "sine"
    osc.frequency.setValueAtTime(520, time)
    osc.frequency.exponentialRampToValueAtTime(140, time + 0.16)
    osc.frequency.exponentialRampToValueAtTime(280, time + 0.26)
    osc.frequency.exponentialRampToValueAtTime(80, time + 0.42)
    const gain = env(busName, time, 0.28, 0.008, 0.4)
    osc.connect(gain)
    osc.start(time)
    osc.stop(time + 0.48)
  }

  function playWhistle(time, busName) {
    const osc = tag(ctx.createOscillator(), busName)
    osc.type = "sine"
    osc.frequency.setValueAtTime(640, time)
    osc.frequency.exponentialRampToValueAtTime(1680, time + 0.22)
    osc.frequency.exponentialRampToValueAtTime(520, time + 0.5)
    const gain = env(busName, time, 0.16, 0.03, 0.48)
    osc.connect(gain)
    osc.start(time)
    osc.stop(time + 0.55)
  }

  function playSparkle(time, busName) {
    ;[880, 1175, 1568, 2093].forEach((freq, index) => {
      const when = time + index * 0.045
      const osc = tag(ctx.createOscillator(), busName)
      osc.type = "sine"
      osc.frequency.setValueAtTime(freq, when)
      const gain = env(busName, when, 0.1, 0.004, 0.18)
      osc.connect(gain)
      osc.start(when)
      osc.stop(when + 0.22)
    })
  }

  function playSfx(id, time = null, busName = "sfx") {
    unlock()
    if (ios) return
    const when = time ?? ctx.currentTime
    if (id === "clap") playClap(when, busName)
    else if (id === "boing") playBoing(when, busName)
    else if (id === "whistle") playWhistle(when, busName)
    else if (id === "sparkle") playSparkle(when, busName)
  }

  function kick(time) {
    const osc = tag(ctx.createOscillator(), "rhythm")
    osc.type = "sine"
    osc.frequency.setValueAtTime(160, time)
    osc.frequency.exponentialRampToValueAtTime(48, time + 0.1)
    const gain = env("rhythm", time, 0.55, 0.004, 0.16)
    osc.connect(gain)
    osc.start(time)
    osc.stop(time + 0.2)
  }

  function snare(time) {
    const osc = tag(ctx.createOscillator(), "rhythm")
    osc.type = "triangle"
    osc.frequency.setValueAtTime(190, time)
    const gain = env("rhythm", time, 0.18, 0.004, 0.1)
    osc.connect(gain)
    osc.start(time)
    osc.stop(time + 0.14)
    burst(time, "rhythm", 0.12, 1800, 0.22, 0.1)
  }

  function hat(time) {
    burst(time, "rhythm", 0.04, 7000, 0.1, 0.04)
  }

  function ride(time) {
    const osc = tag(ctx.createOscillator(), "rhythm")
    osc.type = "square"
    osc.frequency.setValueAtTime(740, time)
    const filter = tag(ctx.createBiquadFilter(), "rhythm")
    filter.type = "bandpass"
    filter.frequency.value = 1800
    filter.Q.value = 3
    const gain = env("rhythm", time, 0.08, 0.002, 0.12)
    osc.connect(filter)
    filter.connect(gain)
    osc.start(time)
    osc.stop(time + 0.14)
  }

  function drumHit(kind, time) {
    if (kind === "kick") kick(time)
    else if (kind === "snare") snare(time)
    else if (kind === "hat") hat(time)
    else if (kind === "clap") playClap(time, "rhythm")
    else ride(time)
  }

  const LOOPS = {
    march: [
      { drum: "kick", steps: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0] },
      { drum: "snare", steps: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0] },
      { drum: "hat", steps: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0] },
    ],
    star: [
      { drum: "kick", steps: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0] },
      { drum: "clap", steps: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1] },
      { drum: "hat", steps: [1, 1, 1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 0] },
    ],
    jazzy: [
      { drum: "kick", steps: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0] },
      { drum: "snare", steps: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0] },
      { drum: "ride", steps: [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1] },
    ],
    dance: [
      { drum: "kick", steps: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] },
      { drum: "clap", steps: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0] },
      { drum: "hat", steps: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0] },
    ],
  }

  function stopRhythm() {
    rhythmToken += 1
    rhythmOn = false
    clearTimeout(rhythmTimer)
    killBus("rhythm")
  }

  function startRhythm(id) {
    unlock()
    stopRhythm()
    if (!id || !LOOPS[id]) return
    const token = rhythmToken
    rhythmOn = true
    const rows = LOOPS[id]
    let step = 0
    let next = clock() + 0.05
    const tick = () => {
      if (token !== rhythmToken) return
      const at = clock()
      if (next < at - 0.05) next = at
      let guard = 0
      while (next < at + 0.16 && guard < 8) {
        const bpm = Math.max(48, hooks.getBpm())
        const stepDur = 60 / bpm / 4
        for (const row of rows) {
          if (row.steps[step] && !ios) drumHit(row.drum, next)
        }
        if (step % 4 === 0) hooks.onBeat()
        step = (step + 1) % 16
        next += stepDur
        guard += 1
      }
      rhythmTimer = setTimeout(tick, 40)
    }
    tick()
  }

  function stopMelody() {
    melodyToken += 1
    melodyPlaying = false
    clearTimeout(melodyTimer)
    cancelAnimationFrame(highlightRaf)
    killBus("melody")
    hooks.onHighlight(-1)
  }

  function runMelody(events, token) {
    melodyPlaying = true
    hooks.onStart()
    let cursor = 0
    let next = clock() + 0.02
    const timeline = []

    const watch = () => {
      if (token !== melodyToken || !melodyPlaying) return
      const now = clock()
      let lit = -1
      for (let i = timeline.length - 1; i >= 0; i--) {
        const item = timeline[i]
        if (now >= item.time && now < item.until) {
          lit = item.index
          break
        }
      }
      hooks.onHighlight(lit)
      highlightRaf = requestAnimationFrame(watch)
    }

    const tick = () => {
      if (token !== melodyToken) return
      const at = clock()
      if (next < at - 0.05) next = at
      let guard = 0
      while (cursor < events.length && next < at + 0.2 && guard < 16) {
        const event = events[cursor]
        const beats = event.beats > 0 ? event.beats : 0.25
        const dur = beats * (60 / Math.max(48, hooks.getBpm()))
        if (event.note) voice(hooks.getInstrument(), event.note, next, Math.max(0.08, dur * 0.92), "melody")
        if (event.sfx) playSfx(event.sfx, next, "melody")
        else if (hooks.getSilly() && event.note && cursor % 5 === 4) {
          const names = ["clap", "boing", "whistle", "sparkle"]
          playSfx(names[(Math.random() * names.length) | 0], next, "melody")
        }
        timeline.push({
          index: event.hidden ? -1 : cursor,
          time: next,
          until: next + Math.max(dur, 0.06),
        })
        next += dur
        cursor += 1
        guard += 1
      }
      if (cursor >= events.length) {
        const wait = Math.max(30, (next - clock()) * 1000 + 40)
        melodyTimer = setTimeout(() => {
          if (token !== melodyToken) return
          melodyPlaying = false
          cancelAnimationFrame(highlightRaf)
          hooks.onHighlight(-1)
          hooks.onMelodyDone()
        }, wait)
        return
      }
      melodyTimer = setTimeout(tick, 40)
    }

    tick()
    highlightRaf = requestAnimationFrame(watch)
  }

  function playMelody(events) {
    unlock()
    stopMelody()
    if (!events?.length) {
      hooks.onMelodyDone()
      return
    }
    const token = melodyToken
    if (ios) {
      runMelody(events, token)
      return
    }
    const inst = hooks.getInstrument()
    const wait = inst === "surprise" ? decodeAll() : whenReady(inst)
    wait.then(() => {
      if (token !== melodyToken) return
      runMelody(events, token)
    })
  }

  function startNote(note, instrument) {
    unlock()
    const id = instrument === "surprise" ? VOICES[(Math.random() * VOICES.length) | 0] : instrument
    if (ios) {
      const plucked = id === "guitar" || id === "drums"
      const handle = startHtml(id, note, plucked ? (id === "guitar" ? 2.1 : 0.5) : 0, "keys")
      return () => {
        if (!plucked) handle.stop()
      }
    }
    let released = false
    let handle = null
    const begin = () => {
      if (!nearest(id, note)) return
      if (released) {
        playSample(id, note, ctx.currentTime, id === "guitar" ? 0.7 : 0.4, "keys")
        return
      }
      handle = holdSample(id, note, "keys")
    }
    if (nearest(id, note)) begin()
    else decodeNote(id, note).then(begin)
    return () => {
      released = true
      handle?.release()
    }
  }

  function stopAll() {
    stopMelody()
    stopRhythm()
    killBus("keys")
    killBus("sfx")
    hooks.onHalted()
  }

  return {
    setHooks,
    unlock,
    setVolume,
    playMelody,
    startRhythm,
    stopRhythm,
    playSfx,
    startNote,
    stopAll,
    isMelodyPlaying: () => melodyPlaying,
    isRhythmOn: () => rhythmOn,
  }
}
