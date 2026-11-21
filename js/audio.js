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

const fetched = Promise.all(Object.entries(LIBRARY).flatMap(([inst, notes]) => notes.map(async (note) => {
  try {
    const response = await fetch(`samples/${inst}/${note}.mp3`)
    if (!response.ok) throw new Error(String(response.status))
    return { inst, note, buf: await response.arrayBuffer() }
  } catch {
    return null
  }
})))

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
  }

  function setHooks(next) {
    Object.assign(hooks, next)
    if (keysReady) hooks.onKeysReady()
  }

  function ensure() {
    if (ctx) return
    const AudioCtx = window.AudioContext || window.webkitAudioContext
    ctx = new AudioCtx({ latencyHint: "interactive" })
    master = ctx.createGain()
    master.gain.value = volume
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -12
    comp.knee.value = 8
    comp.ratio.value = 2.2
    comp.attack.value = 0.008
    comp.release.value = 0.18
    melodyBus = ctx.createGain()
    rhythmBus = ctx.createGain()
    sfxBus = ctx.createGain()
    melodyBus.gain.value = 0.95
    rhythmBus.gain.value = 0.42
    sfxBus.gain.value = 0.7
    melodyBus.connect(master)
    rhythmBus.connect(master)
    sfxBus.connect(master)
    master.connect(comp)
    comp.connect(ctx.destination)
  }

  function markKeysReady() {
    if (keysReady || !gate.piano.done || !gate.guitar.done) return
    keysReady = true
    hooks.onKeysReady()
  }

  function decodeAll() {
    if (decodePromise) return decodePromise
    ensure()
    decodePromise = (async () => {
      const items = await fetched
      const order = ["piano", "guitar", "trumpet", "flute", "saxophone", "drums"]
      for (const inst of order) {
        await Promise.all(items.filter((item) => item && item.inst === inst).map(async (item) => {
          if (cache[inst][item.note]) return
          try {
            cache[inst][item.note] = await ctx.decodeAudioData(item.buf.slice(0))
          } catch { /* skip a bad file; the nearest note covers it */ }
        }))
        finishGate(inst)
        markKeysReady()
      }
    })().catch(() => {
      for (const inst of Object.keys(LIBRARY)) finishGate(inst)
      markKeysReady()
    })
    return decodePromise
  }

  function unlock() {
    ensure()
    if (ctx.state !== "running") ctx.resume()
    decodeAll()
  }

  function whenReady(inst) {
    decodeAll()
    return gate[inst]?.promise || Promise.resolve()
  }

  function setVolume(value) {
    volume = Math.min(1, Math.max(0, value))
    if (master) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.02)
  }

  function tag(node, bus) {
    node.__bus = bus
    live.add(node)
    return node
  }

  function killBus(bus) {
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
    src.start(time, offset)
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
    let next = ctx.currentTime + 0.05
    const tick = () => {
      if (token !== rhythmToken) return
      if (next < ctx.currentTime - 0.05) next = ctx.currentTime
      let guard = 0
      while (next < ctx.currentTime + 0.16 && guard < 8) {
        const bpm = Math.max(48, hooks.getBpm())
        const stepDur = 60 / bpm / 4
        for (const row of rows) {
          if (row.steps[step]) drumHit(row.drum, next)
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
    let next = ctx.currentTime + 0.05
    const timeline = []

    const watch = () => {
      if (token !== melodyToken || !melodyPlaying) return
      const now = ctx.currentTime
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
      if (next < ctx.currentTime - 0.05) next = ctx.currentTime
      let guard = 0
      while (cursor < events.length && next < ctx.currentTime + 0.2 && guard < 16) {
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
        const wait = Math.max(30, (next - ctx.currentTime) * 1000 + 40)
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
    let released = false
    let handle = null
    const begin = () => {
      if (released) return
      handle = holdSample(id, note, "keys")
    }
    if (nearest(id, note)) begin()
    else whenReady(id).then(begin)
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

  decodeAll()

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
