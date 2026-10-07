// The app's page links, shared by the top app bar (App.tsx) and the Disk Box sidebar that replaces
// it on a floppy's page (#498). App.tsx decides which the signed-in person sees (Control Panel is
// operator-only) and hands the list down through AppNavContext.

import { createContext } from "react";
import { vocabulary } from "./vocabulary.ts";

export interface NavItem {
  to: string;
  end?: boolean;
  label: string;
  hint: string;
  operatorOnly?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: "/", end: true, label: vocabulary.desk.one, hint: "the Outfitter desktop" },
  { to: "/fleet", label: vocabulary.sessionList.one, hint: vocabulary.sessionList.hint },
  { to: "/gurus", label: vocabulary.guru.many, hint: vocabulary.guru.hint },
  { to: "/github", label: vocabulary.github.one, hint: vocabulary.github.hint },
  { to: "/providers", label: vocabulary.provider.many, hint: vocabulary.provider.hint },
  { to: "/local-models", label: vocabulary.modem.many, hint: vocabulary.modem.hint },
  { to: "/devices", label: vocabulary.device.many, hint: vocabulary.device.hint },
  { to: "/account", label: vocabulary.account.one, hint: vocabulary.account.hint },
  { to: "/subscriptions", label: vocabulary.subscription.many, hint: vocabulary.subscription.hint },
  { to: "/settings", label: vocabulary.settings.one, hint: `${vocabulary.settings.hint} — ${vocabulary.operator.hint}`, operatorOnly: true },
];

/** The links this person sees. Defaults to everyone's (no Control Panel). */
export const AppNavContext = createContext<NavItem[]>(NAV_ITEMS.filter((item) => !item.operatorOnly));

/** The running Outfitter version's label ("2026.10.01.1"), for chrome that stands in for the app bar. */
export const AppVersionContext = createContext<string | null>(null);
