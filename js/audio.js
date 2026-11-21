const PITCH = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
const VOICES = ["piano", "trumpet", "guitar", "flute", "saxophone", "drums"]

export function noteFreq(note) {
  const match = /^([A-G])(\d)$/.exec(note || "")
  if (!match) return null
  const midi = (Number(match[2]) + 1) * 12 + PITCH[match[1]]
  return 440 * 2 ** ((midi - 69) / 12)
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

  const hooks = {
    getBpm: () => 110,
    getInstrument: () => "piano",
    getSilly: () => false,
    onHighlight: () => {},
    onStart: () => {},
    onMelodyDone: () => {},
    onHalted: () => {},
    onBeat: () => {},
  }

  function setHooks(next) {
    Object.assign(hooks, next)
  }

  function ensure() {
    if (ctx) return
    const AudioCtx = window.AudioContext || window.webkitAudioContext
    ctx = new AudioCtx({ latencyHint: "interactive" })
    master = ctx.createGain()
    master.gain.value = volume
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -16
    comp.knee.value = 16
    comp.ratio.value = 8
    comp.attack.value = 0.004
    comp.release.value = 0.18
    melodyBus = ctx.createGain()
    rhythmBus = ctx.createGain()
    sfxBus = ctx.createGain()
    melodyBus.gain.value = 0.95
    rhythmBus.gain.value = 0.5
    sfxBus.gain.value = 0.7
    melodyBus.connect(master)
    rhythmBus.connect(master)
    sfxBus.connect(master)
    master.connect(comp)
    comp.connect(ctx.destination)
  }

  function unlock() {
    ensure()
    if (ctx.state !== "running") ctx.resume()
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

  function env(busName, time, peak, attack, release) {
    const gain = tag(ctx.createGain(), busName)
    gain.gain.setValueAtTime(0.0001, time)
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0001), time + attack)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + attack + release)
    gain.connect(busOf(busName))
    return gain
  }

  function piano(freq, time, dur, busName) {
    const partials = [1, 2, 3, 4, 6]
    const amps = [0.2, 0.09, 0.045, 0.02, 0.01]
    const release = Math.max(0.18, Math.min(0.85, dur * 1.15))
    partials.forEach((harmonic, index) => {
      const osc = tag(ctx.createOscillator(), busName)
      osc.type = "sine"
      osc.frequency.setValueAtTime(freq * harmonic, time)
      const gain = env(busName, time, amps[index], 0.008, release / (1 + index * 0.35))
      osc.connect(gain)
      osc.start(time)
      osc.stop(time + release + 0.1)
    })
  }

  function brass(freq, time, dur, busName, bright) {
    const osc = tag(ctx.createOscillator(), busName)
    osc.type = bright ? "sawtooth" : "square"
    osc.frequency.setValueAtTime(freq * 0.97, time)
    osc.frequency.exponentialRampToValueAtTime(freq, time + 0.07)
    const filter = tag(ctx.createBiquadFilter(), busName)
    filter.type = "lowpass"
    filter.Q.value = bright ? 5 : 7
    const open = Math.min(bright ? 2800 : 2200, freq * (bright ? 7 : 5))
    filter.frequency.setValueAtTime(420, time)
    filter.frequency.exponentialRampToValueAtTime(open, time + 0.09)
    filter.frequency.exponentialRampToValueAtTime(Math.max(300, freq * 2), time + Math.max(dur, 0.2))
    const gain = env(busName, time, bright ? 0.16 : 0.14, 0.03, Math.max(0.16, dur * 0.9))
    osc.connect(filter)
    filter.connect(gain)
    osc.start(time)
    osc.stop(time + dur + 0.3)
  }

  function guitar(freq, time, dur, busName) {
    const delay = tag(ctx.createDelay(1), busName)
    delay.delayTime.setValueAtTime(1 / freq, time)
    const damp = tag(ctx.createBiquadFilter(), busName)
    damp.type = "lowpass"
    damp.frequency.value = 2400
    const feedback = tag(ctx.createGain(), busName)
    feedback.gain.setValueAtTime(0.9, time)
    feedback.gain.exponentialRampToValueAtTime(0.2, time + Math.max(0.28, dur + 0.15))
    delay.connect(damp)
    damp.connect(feedback)
    feedback.connect(delay)
    const burst = Math.floor(ctx.sampleRate * 0.03)
    const buffer = ctx.createBuffer(1, burst, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < burst; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / burst)
    const noise = tag(ctx.createBufferSource(), busName)
    noise.buffer = buffer
    noise.connect(delay)
    const gain = env(busName, time, 0.28, 0.005, Math.max(0.25, dur + 0.2))
    delay.connect(gain)
    noise.start(time)
    noise.stop(time + 0.04)
  }

  function flute(freq, time, dur, busName) {
    const osc = tag(ctx.createOscillator(), busName)
    osc.type = "sine"
    osc.frequency.setValueAtTime(freq, time)
    if (dur > 0.28) {
      const lfo = tag(ctx.createOscillator(), busName)
      const depth = tag(ctx.createGain(), busName)
      lfo.frequency.value = 5
      depth.gain.value = freq * 0.012
      lfo.connect(depth)
      depth.connect(osc.frequency)
      lfo.start(time)
      lfo.stop(time + dur + 0.2)
    }
    const air = tag(ctx.createBufferSource(), busName)
    air.buffer = noiseBuffer(Math.min(1, dur + 0.1))
    const airFilter = tag(ctx.createBiquadFilter(), busName)
    airFilter.type = "bandpass"
    airFilter.frequency.value = freq * 2
    airFilter.Q.value = 0.7
    const airGain = env(busName, time, 0.03, 0.05, Math.max(0.2, dur))
    air.connect(airFilter)
    airFilter.connect(airGain)
    air.start(time)
    air.stop(time + dur + 0.05)
    const gain = env(busName, time, 0.2, Math.min(0.08, dur * 0.4), Math.max(0.15, dur * 0.85))
    osc.connect(gain)
    osc.start(time)
    osc.stop(time + dur + 0.2)
  }

  function drums(freq, time, dur, busName) {
    const osc = tag(ctx.createOscillator(), busName)
    osc.type = "sine"
    osc.frequency.setValueAtTime(freq * 1.6, time)
    osc.frequency.exponentialRampToValueAtTime(Math.max(50, freq * 0.85), time + 0.09)
    const gain = env(busName, time, 0.34, 0.004, Math.max(0.14, dur * 0.55))
    osc.connect(gain)
    osc.start(time)
    osc.stop(time + dur + 0.2)
    const snap = tag(ctx.createBufferSource(), busName)
    snap.buffer = noiseBuffer(0.05)
    const snapFilter = tag(ctx.createBiquadFilter(), busName)
    snapFilter.type = "highpass"
    snapFilter.frequency.value = 900
    const snapGain = env(busName, time, 0.12, 0.002, 0.06)
    snap.connect(snapFilter)
    snapFilter.connect(snapGain)
    snap.start(time)
    snap.stop(time + 0.05)
  }

  function voice(instrument, freq, time, dur, busName) {
    const id = instrument === "surprise" ? VOICES[(Math.random() * VOICES.length) | 0] : instrument
    if (id === "piano") piano(freq, time, dur, busName)
    else if (id === "trumpet") brass(freq, time, dur, busName, true)
    else if (id === "guitar") guitar(freq, time, dur, busName)
    else if (id === "flute") flute(freq, time, dur, busName)
    else if (id === "saxophone") brass(freq, time, dur, busName, false)
    else drums(freq, time, dur, busName)
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

  function playMelody(events) {
    unlock()
    stopMelody()
    if (!events?.length) {
      hooks.onMelodyDone()
      return
    }
    const token = melodyToken
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
        if (event.note) {
          const freq = noteFreq(event.note)
          if (freq) voice(hooks.getInstrument(), freq, next, Math.max(0.08, dur * 0.92), "melody")
        }
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

  function startNote(note, instrument) {
    unlock()
    const freq = noteFreq(note)
    if (!freq) return () => {}
    const now = ctx.currentTime
    const id = instrument === "surprise" ? VOICES[(Math.random() * VOICES.length) | 0] : instrument
    if (id !== "flute" && id !== "saxophone" && id !== "trumpet") {
      voice(id, freq, now, id === "piano" ? 0.55 : 0.38, "keys")
      return () => {}
    }
    const gain = tag(ctx.createGain(), "keys")
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(id === "flute" ? 0.2 : 0.15, now + 0.04)
    gain.connect(melodyBus)
    const osc = tag(ctx.createOscillator(), "keys")
    osc.type = id === "flute" ? "sine" : "sawtooth"
    osc.frequency.setValueAtTime(freq, now)
    let filter = null
    if (id !== "flute") {
      filter = tag(ctx.createBiquadFilter(), "keys")
      filter.type = "lowpass"
      filter.frequency.setValueAtTime(id === "trumpet" ? 2200 : 1400, now)
      osc.connect(filter)
      filter.connect(gain)
    } else {
      osc.connect(gain)
    }
    osc.start(now)
    let released = false
    return () => {
      if (released || !ctx) return
      released = true
      const at = ctx.currentTime
      try {
        gain.gain.cancelScheduledValues(at)
        gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), at)
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.12)
        osc.stop(at + 0.14)
      } catch { /* stopped already */ }
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
