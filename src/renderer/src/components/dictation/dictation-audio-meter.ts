export type DictationMeterState = {
  level: number
  peak: number
  isSpeaking: boolean
  isClipping: boolean
  lastUpdatedAt: number
}

export type DictationMeterAnalyzerState = DictationMeterState & {
  noiseFloor: number
  smoothedLevel: number
  clippingUntil: number
}

export const DEFAULT_DICTATION_METER: DictationMeterState = {
  level: 0,
  peak: 0,
  isSpeaking: false,
  isClipping: false,
  lastUpdatedAt: 0
}

const CLIPPING_THRESHOLD = 0.98
const CLIPPING_HOLD_MS = 500

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function createDictationMeterAnalyzerState(): DictationMeterAnalyzerState {
  return {
    ...DEFAULT_DICTATION_METER,
    noiseFloor: 0.008,
    smoothedLevel: 0,
    clippingUntil: Number.NEGATIVE_INFINITY
  }
}

export function measureDictationAudioChunk(samples: Float32Array): {
  rms: number
  peak: number
} {
  if (samples.length === 0) {
    return { rms: 0, peak: 0 }
  }

  let sumSquares = 0
  let peak = 0
  for (const sample of samples) {
    const absoluteSample = Math.abs(sample)
    sumSquares += sample * sample
    peak = Math.max(peak, absoluteSample)
  }
  return {
    rms: Math.sqrt(sumSquares / samples.length),
    peak: clamp(peak, 0, 1)
  }
}

export function analyzeDictationAudioChunk(
  samples: Float32Array,
  now: number,
  previous: DictationMeterAnalyzerState
): DictationMeterAnalyzerState {
  const { rms, peak } = measureDictationAudioChunk(samples)
  const noiseFloor = Math.max(
    0.004,
    previous.noiseFloor * 0.96 + Math.min(rms, previous.noiseFloor * 2) * 0.04
  )
  const rawLevel = clamp((rms - noiseFloor) / 0.16, 0, 1)
  const smoothing = rawLevel > previous.smoothedLevel ? 0.58 : 0.2
  const smoothedLevel = previous.smoothedLevel + (rawLevel - previous.smoothedLevel) * smoothing
  const clippingUntil = peak >= CLIPPING_THRESHOLD ? now + CLIPPING_HOLD_MS : previous.clippingUntil

  return {
    level: smoothedLevel,
    peak,
    isSpeaking: smoothedLevel >= 0.1 || peak >= 0.18,
    isClipping: now <= clippingUntil,
    lastUpdatedAt: now,
    noiseFloor,
    smoothedLevel,
    clippingUntil
  }
}

export function toPublicDictationMeterState(
  state: DictationMeterAnalyzerState
): DictationMeterState {
  return {
    level: state.level,
    peak: state.peak,
    isSpeaking: state.isSpeaking,
    isClipping: state.isClipping,
    lastUpdatedAt: state.lastUpdatedAt
  }
}
