// #267: the microphone list and the remembered choice.
import { describe, expect, it } from "vitest";
import { listMics, loadMicChoice, micConstraints, resolveMic, saveMicChoice, MIC_LABEL_STORAGE_KEY, MIC_STORAGE_KEY } from "../src/lib/voice-mic.ts";

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
  it("round-trips id and name, clears back to the default, and survives storage that throws", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    saveMicChoice({ id: "a2", label: "Shure MV7" }, storage);
    expect([store.get(MIC_STORAGE_KEY), store.get(MIC_LABEL_STORAGE_KEY)]).toEqual(["a2", "Shure MV7"]);
    expect(loadMicChoice(storage)).toEqual({ id: "a2", label: "Shure MV7" });
    saveMicChoice(undefined, storage);
    expect(loadMicChoice(storage)).toBeUndefined();
    expect(store.size).toBe(0);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(loadMicChoice(broken)).toBeUndefined();
    expect(() => saveMicChoice({ id: "a2" }, broken)).not.toThrow();
  });
});

describe("resolveMic", () => {
  const mics = [{ id: "new-1", label: "MacBook Pro Microphone" }, { id: "new-2", label: "Shure MV7" }];
  it("keeps an id that's connected", () => {
    expect(resolveMic({ id: "new-2", label: "Shure MV7" }, mics)).toEqual({ id: "new-2", label: "Shure MV7" });
  });
  it("finds the same mic by name when the browser issued new ids", () => {
    expect(resolveMic({ id: "old-2", label: "Shure MV7" }, mics)).toEqual({ id: "new-2", label: "Shure MV7" });
  });
  it("never guesses between two mics with the same name", () => {
    const twins = [{ id: "usb-a", label: "USB Audio" }, { id: "usb-b", label: "USB Audio" }];
    expect(resolveMic({ id: "usb-c", label: "USB Audio" }, twins)).toEqual({ id: "usb-c", label: "USB Audio" });
  });
  it("otherwise keeps the saved choice (not connected), and the default stays the default", () => {
    expect(resolveMic({ id: "gone", label: "USB Headset" }, mics)).toEqual({ id: "gone", label: "USB Headset" });
    expect(resolveMic(undefined, mics)).toBeUndefined();
  });
});
