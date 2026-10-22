declare module 'wavtools' {
  export class WavRecorder {
    constructor(options?: { sampleRate?: number; outputToSpeakers?: boolean; debug?: boolean });
    stream: MediaStream | null;
    source: MediaStreamAudioSourceNode | null;
    analyser: AnalyserNode | null;
    getStatus(): 'ended' | 'paused' | 'recording';
    begin(deviceId?: string): Promise<true>;
    record(callback: (data: { mono: ArrayBuffer | Int16Array; raw: ArrayBuffer | Int16Array }) => void, chunkSize?: number): Promise<true>;
    pause(): Promise<true>;
    quit(): Promise<true>;
  }
  export class WavStreamPlayer {
    constructor(options?: { sampleRate?: number });
    context: AudioContext | null;
    stream: AudioWorkletNode | null;
    analyser: AnalyserNode | null;
    connect(): Promise<true>;
    add16BitPCM(data: ArrayBuffer | Int16Array, trackId?: string): Int16Array | undefined;
    interrupt(): Promise<{ trackId: string | null; offset: number; currentTime: number } | null>;
  }
}

