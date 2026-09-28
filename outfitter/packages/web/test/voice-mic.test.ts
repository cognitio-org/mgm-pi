// #267: the microphone list and the remembered choice.
import { describe, expect, it } from "vitest";
import { listMics, loadMicId, micConstraints, saveMicId, MIC_STORAGE_KEY } from "../src/lib/voice-mic.ts";

const dev = (kind: string, deviceId: string, label = "") => ({ kind, deviceId, label, groupId: "g" }) as MediaDeviceInfo;

describe("listMics", () => {
  it("lists audio inputs, without Chrome's default and communications aliases", async () => {
    const r = await listMics({
      enumerateDevices: async () => [
        dev("audioinput", "default", "Default - MacBook Pro Microphone"),
        dev("audioinput", "communications", "Communications - AirPods"),
        dev("audioinput", "a1", "MacBook Pro Microphone"),
        dev("audioinput", "a2", "Shure MV7"),
        dev("audiooutput", "o1", "Speakers"),
        dev("videoinput", "v1", "FaceTime HD Camera"),
      ],
    });
    expect(r).toEqual({ labelled: true, mics: [{ id: "a1", label: "MacBook Pro Microphone" }, { id: "a2", label: "Shure MV7" }] });
  });
  it("before permission: no names (and sometimes empty ids), so it says it isn't labelled", async () => {
    const r = await listMics({ enumerateDevices: async () => [dev("audioinput", ""), dev("audioinput", "x")] });
    expect(r).toEqual({ labelled: false, mics: [{ id: "x", label: "Microphone 1" }] });
  });
  it("no mediaDevices at all", async () => {
    expect(await listMics(undefined)).toEqual({ mics: [], labelled: false });
  });
});

describe("micConstraints", () => {
  it("asks for the chosen device exactly, or the default", () => {
    expect(micConstraints("a2")).toEqual({ echoCancellation: true, noiseSuppression: true, deviceId: { exact: "a2" } });
    expect(micConstraints(undefined)).toEqual({ echoCancellation: true, noiseSuppression: true });
  });
});

describe("saved choice", () => {
  it("round-trips, clears back to the default, and survives storage that throws", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    saveMicId("a2", storage);
    expect(store.get(MIC_STORAGE_KEY)).toBe("a2");
    expect(loadMicId(storage)).toBe("a2");
    saveMicId(undefined, storage);
    expect(loadMicId(storage)).toBeUndefined();
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(loadMicId(broken)).toBeUndefined();
    expect(() => saveMicId("a2", broken)).not.toThrow();
  });
});
