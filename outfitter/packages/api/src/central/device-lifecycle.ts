// Central sign-in (#389, docs/specs/central-auth.md §5.3): device lifecycle hooks. The device-code
// flow (CA-1, routes/device.ts) announces a login and a revoke here; whoever needs to act on them
// registers a hook in server.ts (CA-5's router keys: central/litellm-keys.ts
// registerLitellmDeviceHooks). Neither side imports the other, so the two are built and changed
// independently.
//
// Spec-owned (central-auth.md §9): the event and delivery shapes are the contract.
//
// A failing hook never fails the login or the revoke: a device that signed in without a router key
// still works (signed in, no router), and a revoke always revokes. The failure is logged and
// reported in the login's `delivery.problems`, so Kernal can say why the router is missing.

/** The device fields hooks see: no hashes. */
export interface LifecycleDevice {
  id: string;
  userId: string;
  ownerEmail: string;
  name: string;
  platform?: string;
  kernalVersion?: string;
}

export interface DeviceLoginEvent {
  device: LifecycleDevice;
}

export type DeviceRevokedReason = "logout" | "revoked" | "operator" | "access-removed" | "refresh-reuse";

export interface DeviceRevokedEvent {
  device: LifecycleDevice;
  reason: DeviceRevokedReason;
}

/** What a hook hands the device with its first tokens (POST /api/device/token's `delivery`). It
 * is sent once, in that one answer, and Outfitter keeps none of it. */
export interface DeviceDelivery {
  /** CA-5: this device's own router key. */
  routerKey?: { key: string; baseUrl: string; alias: string; expiresAt?: string };
}

export interface DeviceLoginResult {
  delivery: DeviceDelivery;
  /** One line per hook that failed, e.g. "router key: LiteLLM did not answer". Never a secret. */
  problems: string[];
}

export interface DeviceLifecycleHook {
  /** Short, for logs and `problems`: "router key". */
  name: string;
  /** Runs at the first successful token poll of an approved code, before the answer is sent. */
  onLogin?(event: DeviceLoginEvent): Promise<DeviceDelivery | void>;
  /** Runs after the device is marked revoked (its tokens already fail). */
  onRevoked?(event: DeviceRevokedEvent): Promise<void>;
}

export class DeviceLifecycle {
  private readonly hooks: DeviceLifecycleHook[] = [];
  private readonly log: (msg: string, err?: unknown) => void;

  constructor(log: (msg: string, err?: unknown) => void = () => {}) {
    this.log = log;
  }

  register(hook: DeviceLifecycleHook): void {
    this.hooks.push(hook);
  }

  /** Every hook's onLogin, in registration order; deliveries are merged (a later hook's field wins). */
  async login(event: DeviceLoginEvent): Promise<DeviceLoginResult> {
    const result: DeviceLoginResult = { delivery: {}, problems: [] };
    for (const hook of this.hooks) {
      if (!hook.onLogin) continue;
      try {
        const delivery = await hook.onLogin(event);
        if (delivery) Object.assign(result.delivery, delivery);
      } catch (err) {
        this.log(`device lifecycle: ${hook.name} failed on login of ${event.device.id}`, err);
        result.problems.push(`${hook.name}: ${problemText(err)}`);
      }
    }
    return result;
  }

  /** Every hook's onRevoked; failures are logged, never thrown. */
  async revoked(event: DeviceRevokedEvent): Promise<void> {
    for (const hook of this.hooks) {
      if (!hook.onRevoked) continue;
      try {
        await hook.onRevoked(event);
      } catch (err) {
        this.log(`device lifecycle: ${hook.name} failed on revoke of ${event.device.id}`, err);
      }
    }
  }
}

/** A hook's error as one short line. A hook must not put a secret in its error messages. */
function problemText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split("\n")[0].slice(0, 200) || "failed";
}
